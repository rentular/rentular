/**
 * Route tests for manual paid marks: who may undo (POST
 * /payments/unmark-month-paid), that marking goes through the mark service
 * with the right source, and the landlord email link's paid page with its
 * undo link (GET /landlord-action/:token).
 *
 * The mark and undo logic itself is covered against an in-memory store in
 * services/__tests__/manualMarks.test.ts; here it is spied on.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PropertyManagerRole } from "@rentular/shared";

const getAccessiblePropertyIds = vi.fn(async () => ["prop-1"]);
const getUserPropertyRole = vi.fn();
const ROLE_LEVEL: Record<string, number> = { viewer: 1, accountant: 2, manager: 3, co_owner: 4, owner: 5 };
function hasMinimumRole(role: PropertyManagerRole, min: PropertyManagerRole): boolean {
  return (ROLE_LEVEL[role] ?? 0) >= (ROLE_LEVEL[min] ?? Infinity);
}
vi.mock("../../lib/propertyAccess", () => ({
  getAccessiblePropertyIds,
  getUserPropertyRole,
  hasMinimumRole,
  ROLE_LEVEL,
}));

const LEASE = {
  id: "lease-1",
  ownerId: "owner-1",
  propertyId: "prop-1",
  monthlyRent: "780.00",
  monthlyCharges: "0.00",
  paymentDay: 1,
};

const markMonthPaid = vi.fn(async () => ({ id: "p1", status: "paid", markId: "mark-1" }));
const markPaymentPaid = vi.fn(async () => ({ id: "p1", status: "paid", markId: "mark-1" }));
const undoMonthPaid = vi.fn();
vi.mock("../../services/manualMarks", () => ({ markMonthPaid, markPaymentPaid, undoMonthPaid }));

const getMark = vi.fn();
const loadLeaseForMark = vi.fn(async (_db: unknown, id: string) => (id === LEASE.id ? LEASE : null));
const loadMarkViews = vi.fn(async () => []);
vi.mock("../../services/manualMarksStore", () => ({
  drizzleMarkStore: vi.fn(() => ({ getMark })),
  loadLeaseForMark,
  loadMarkViews,
}));

vi.mock("../../services/manualReminder", () => ({ sendManualReminder: vi.fn(), NOTHING_OWED_ERROR: "x" }));
vi.mock("../../lib/gocardless", () => ({
  createPayment: vi.fn(),
  retryPayment: vi.fn(),
  cancelPayment: vi.fn(),
  getGoCardlessAvailability: vi.fn(),
  isGoCardlessUnavailable: vi.fn(() => false),
}));
vi.mock("../../lib/gocardlessConnections", () => ({ ownerOfProperty: vi.fn(async () => "owner-1") }));
vi.mock("../../services/paymentStateMachine", () => ({ transitionPayment: vi.fn() }));
vi.mock("../../services/expectedPayments", () => ({
  ensureExpectedPaymentsForAllActive: vi.fn(),
  ensureCurrentMonthPayment: vi.fn(),
  isDepositNote: () => false,
  keepDepositMarker: (_e: string | null | undefined, n: string) => n,
}));
vi.mock("../../services/paymentFollowUp", () => ({ sendReminder: vi.fn(), DEFAULT_SETTINGS: {} }));
vi.mock("../../lib/notificationRecipients", () => ({ getLandlordNotificationRecipients: vi.fn() }));
vi.mock("../../lib/leaseRecipients", () => ({ getLeaseEmailRecipients: vi.fn(), mergeCc: vi.fn() }));
vi.mock("../../lib/sms", () => ({ isSmsConfigured: () => false, normalizePhoneNumber: (s: string) => s }));
vi.mock("../../lib/whatsapp", () => ({ isWhatsAppConfigured: () => false, sendWhatsApp: vi.fn() }));
vi.mock("../../lib/communicationLog", () => ({ sendWhatsAppLogged: vi.fn() }));
vi.mock("../../jobs/smsQueueWorker", () => ({ queueSms: vi.fn() }));
vi.mock("../../jobs/emailQueueWorker", () => ({ queueEmail: vi.fn() }));
vi.mock("../../lib/email", () => ({ renderTemplate: (t: string) => t, sendEmail: vi.fn() }));
vi.mock("bullmq", () => {
  class MockQueue {
    add = vi.fn().mockResolvedValue({ id: "j" });
  }
  class MockWorker {
    on = vi.fn();
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

// Rows returned by the next database selects (the email link's payment lookup).
const selectQueue: unknown[][] = [];
function chain(): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = Promise.resolve(selectQueue.shift() ?? []);
        return r.then.bind(r);
      }
      return () => chain();
    },
  });
}
vi.mock("@rentular/db", () => ({
  getDb: vi.fn(() => ({ select: () => chain(), insert: () => chain(), update: () => chain(), delete: () => chain() })),
  payments: {},
  paymentAllocations: {},
  paymentReminders: {},
  leases: {},
  properties: {},
  leaseTenants: {},
  tenants: {},
  users: {},
  rentDeductions: {},
}));
vi.mock("drizzle-orm", () => {
  const f = vi.fn((...a: unknown[]) => ({ a }));
  return { eq: f, and: f, desc: f, lt: f, gte: f, lte: f, inArray: f, like: f, sql: f, isNotNull: f, isNull: f };
});

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-please-change-0123456789";
  process.env.WEB_URL = "https://www.example.test";
});

beforeEach(() => {
  vi.resetModules();
  getUserPropertyRole.mockReset();
  markMonthPaid.mockClear();
  markPaymentPaid.mockClear();
  undoMonthPaid.mockReset();
  getMark.mockReset();
  loadMarkViews.mockClear();
  selectQueue.length = 0;
});

async function paymentsApp(opts: { tokenScope?: "read" | "write"; tokenId?: string; tool?: boolean } = {}) {
  const { paymentsRouter } = await import("../payments");
  const { requireWriteScope } = await import("../../lib/routeAuth");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "user-A");
    c.set("tokenScope", opts.tokenScope ?? null);
    c.set("tokenId", opts.tokenId ?? null);
    await next();
  });
  app.use("/payments/*", requireWriteScope);
  app.route("/payments", paymentsRouter);
  return app;
}

function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /payments/unmark-month-paid", () => {
  it("lets a manager undo the latest mark of the month", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    undoMonthPaid.mockResolvedValue({ ok: true, already: false, markId: "mark-1", paymentId: "p1", month: "2026-11", deleted: false });
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { already: false, markId: "mark-1", paymentId: "p1", month: "2026-11", deleted: false },
    });
    expect(undoMonthPaid).toHaveBeenCalledWith(expect.anything(), {
      lease: LEASE, month: "2026-11", markId: undefined, actor: "user-A",
    });
  });

  it("accepts a markId instead of a month", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    undoMonthPaid.mockResolvedValue({ ok: true, already: true, markId: "mark-1", paymentId: "p1", month: "2026-11", deleted: false });
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", markId: "mark-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.already).toBe(true);
    expect(undoMonthPaid.mock.calls[0]![1]).toMatchObject({ markId: "mark-1", month: undefined });
  });

  it("needs a month or a markId", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1" });
    expect(res.status).toBe(400);
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("refuses a viewer (403) and never undoes", async () => {
    getUserPropertyRole.mockResolvedValue("viewer");
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(403);
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("refuses an accountant (403)", async () => {
    getUserPropertyRole.mockResolvedValue("accountant");
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(403);
  });

  it("refuses a read-scoped token (403) before the handler runs", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    const app = await paymentsApp({ tokenScope: "read", tokenId: "tok-1" });
    const res = await post(app, "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(403);
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("answers 404 for another landlord's contract", async () => {
    getUserPropertyRole.mockResolvedValue(null);
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(404);
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown contract", async () => {
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "nope", month: "2026-11" });
    expect(res.status).toBe(404);
  });

  it("passes a refusal through as 409 with its code and reason", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    undoMonthPaid.mockResolvedValue({ ok: false, status: 409, code: "bank_matched", error: "matched" });
    const res = await post(await paymentsApp(), "/payments/unmark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "matched", code: "bank_matched" });
  });
});

describe("POST /payments/mark-month-paid records the mark with its source", () => {
  async function mark(opts: Parameters<typeof paymentsApp>[0], headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    getUserPropertyRole.mockResolvedValue("manager");
    const res = await post(await paymentsApp(opts), "/payments/mark-month-paid", { leaseId: "lease-1", month: "2026-11", ...body }, headers);
    expect(res.status).toBe(200);
    expect((await res.json()).data.markId).toBe("mark-1");
    return (markMonthPaid.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
  }

  it("from the web app: overview, by the user", async () => {
    expect(await mark({}, {}, { source: "overview" })).toMatchObject({ source: "overview", actor: "user-A", method: "cash", lease: LEASE });
  });

  it("with a write token: api", async () => {
    expect((await mark({ tokenScope: "write", tokenId: "tok-1" })).source).toBe("api");
  });

  it("from the MCP server: mcp", async () => {
    expect((await mark({ tokenScope: "write", tokenId: "tok-1" }, { "X-Rentular-Tool": "mark_rent_paid" })).source).toBe("mcp");
  });

  it("a viewer cannot mark", async () => {
    getUserPropertyRole.mockResolvedValue("viewer");
    const res = await post(await paymentsApp(), "/payments/mark-month-paid", { leaseId: "lease-1", month: "2026-11" });
    expect(res.status).toBe(403);
    expect(markMonthPaid).not.toHaveBeenCalled();
  });
});

describe("GET /payments/manual-marks", () => {
  it("lists the lease's active marks for anyone with access", async () => {
    getUserPropertyRole.mockResolvedValue("viewer");
    const app = await paymentsApp();
    const res = await app.request("/payments/manual-marks?leaseId=lease-1&month=2026-11");
    expect(res.status).toBe(200);
    expect(loadMarkViews).toHaveBeenCalledWith(expect.anything(), { leaseIds: ["lease-1"], month: "2026-11" });
  });

  it("answers 404 for another landlord's contract", async () => {
    getUserPropertyRole.mockResolvedValue(null);
    const app = await paymentsApp();
    const res = await app.request("/payments/manual-marks?leaseId=lease-1");
    expect(res.status).toBe(404);
    expect(loadMarkViews).not.toHaveBeenCalled();
  });
});

describe("the landlord email link", () => {
  async function linkApp() {
    const { landlordActionsRouter } = await import("../landlordActions");
    const tokens = await import("../../lib/landlordActionToken");
    const app = new Hono();
    app.route("/landlord-action", landlordActionsRouter);
    return { app, tokens };
  }
  const paymentLookup = () => selectQueue.push([{ leaseId: "lease-1", ownerId: "owner-1", ownerLocale: "nl" }]);

  it("paid: marks the row as the landlord and offers an undo link valid as long as the paid link", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    const paidToken = await tokens.signLandlordActionToken("paid", "p1");
    const res = await app.request(`/landlord-action/${paidToken}`);
    const html = await res.text();
    expect(markPaymentPaid).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lease: LEASE, paymentId: "p1", actor: "owner-1", source: "magic_link",
    }));
    expect(html).toContain("Gemarkeerd als betaald");
    expect(html).toContain("Toch niet betaald?");
    expect(html).toContain("Ongedaan maken");
    const link = /https:\/\/www\.example\.test\/api\/v1\/landlord-action\/([^"]+)"/.exec(html);
    expect(link).toBeTruthy();
    const undo = await tokens.verifyLandlordActionToken(link![1]!);
    const paid = await tokens.verifyLandlordActionToken(paidToken);
    expect(undo).toMatchObject({ action: "unpaid", paymentId: "p1", markId: "mark-1", exp: paid.exp });
  });

  it("paid clicked again: offers to undo the mark the row already has", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    markPaymentPaid.mockResolvedValueOnce({ id: "p1", status: "paid", already: true } as never);
    loadMarkViews.mockResolvedValueOnce([{ id: "mark-0", undoable: true }] as never);
    const res = await app.request(`/landlord-action/${await tokens.signLandlordActionToken("paid", "p1")}`);
    const html = await res.text();
    const link = /landlord-action\/([^"]+)"/.exec(html);
    expect((await tokens.verifyLandlordActionToken(link![1]!)).markId).toBe("mark-0");
  });

  it("unpaid: asks to confirm first and changes nothing", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    const token = await tokens.signLandlordUndoToken("p1", "mark-1", Math.floor(Date.now() / 1000) + 3600);
    const res = await app.request(`/landlord-action/${token}`);
    const html = await res.text();
    expect(html).toContain("Markering als betaald ongedaan maken?");
    expect(html).toContain(`${token}?confirm=1`);
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("unpaid confirmed: undoes that mark as the landlord", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    getMark.mockResolvedValue({ id: "mark-1", paymentId: "p1", leaseId: "lease-1" });
    undoMonthPaid.mockResolvedValue({ ok: true, already: false, markId: "mark-1", paymentId: "p1", month: "2026-11", deleted: false });
    const token = await tokens.signLandlordUndoToken("p1", "mark-1", Math.floor(Date.now() / 1000) + 3600);
    const res = await app.request(`/landlord-action/${token}?confirm=1`);
    expect(await res.text()).toContain("De markering als betaald is ongedaan gemaakt.");
    expect(undoMonthPaid).toHaveBeenCalledWith(expect.anything(), { lease: LEASE, markId: "mark-1", actor: "owner-1" });
  });

  it("unpaid refused because the payment got bank matched: says so", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    getMark.mockResolvedValue({ id: "mark-1", paymentId: "p1", leaseId: "lease-1" });
    undoMonthPaid.mockResolvedValue({ ok: false, status: 409, code: "bank_matched", error: "x" });
    const token = await tokens.signLandlordUndoToken("p1", "mark-1", Math.floor(Date.now() / 1000) + 3600);
    const res = await app.request(`/landlord-action/${token}?confirm=1`);
    expect(await res.text()).toContain("gekoppeld aan een banktransactie");
  });

  it("unpaid for a mark of another payment is not found", async () => {
    const { app, tokens } = await linkApp();
    paymentLookup();
    getMark.mockResolvedValue({ id: "mark-1", paymentId: "other", leaseId: "lease-1" });
    const token = await tokens.signLandlordUndoToken("p1", "mark-1", Math.floor(Date.now() / 1000) + 3600);
    const res = await app.request(`/landlord-action/${token}?confirm=1`);
    expect(await res.text()).toContain("Deze betaling kon niet worden gevonden.");
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });

  it("an expired undo link does nothing", async () => {
    const { app, tokens } = await linkApp();
    const token = await tokens.signLandlordUndoToken("p1", "mark-1", Math.floor(Date.now() / 1000) - 60);
    const res = await app.request(`/landlord-action/${token}?confirm=1`);
    expect(await res.text()).toContain("This link is invalid or has expired.");
    expect(undoMonthPaid).not.toHaveBeenCalled();
  });
});
