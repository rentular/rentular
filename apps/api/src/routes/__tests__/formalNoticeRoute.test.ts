/**
 * Route tests for POST /payments/formal-notice: who may generate a formal
 * notice, what the response carries, and how the service's refusals reach the
 * caller.
 *
 * The authorisation chain is the whole point of this file. The endpoint returns
 * tenant names, their addresses and the amounts claimed, so every check has to
 * run before the service is called, and the 403 cases assert exactly that: the
 * service was never reached. The letters themselves are covered against a
 * mocked database in services/__tests__/formalNotice.test.ts.
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

const generateFormalNotice = vi.fn();
vi.mock("../../services/formalNotice", () => ({
  generateFormalNotice: (input: unknown) => generateFormalNotice(input),
}));

vi.mock("../../services/manualReminder", () => ({ sendManualReminder: vi.fn(), NOTHING_OWED_ERROR: "x" }));
vi.mock("../../services/manualMarks", () => ({
  markMonthPaid: vi.fn(),
  markPaymentPaid: vi.fn(),
  undoMonthPaid: vi.fn(),
}));
vi.mock("../../services/manualMarksStore", () => ({
  drizzleMarkStore: vi.fn(() => ({ getMark: vi.fn() })),
  loadLeaseForMark: vi.fn(async () => null),
  loadMarkViews: vi.fn(async () => []),
}));
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

// Rows the next database selects return (the handler's lease lookup).
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

const PDF_BASE64 = Buffer.from("%PDF-1.3 letter").toString("base64");

function okResult() {
  return {
    ok: true,
    letters: [
      {
        tenantId: "t-1",
        recipientName: "Łukasz Wójcik",
        language: "nl",
        addressSource: "property",
        filename: "ingebrekestelling-lease-1-2026-11-18-1.pdf",
        pdfBase64: PDF_BASE64,
        communicationId: "comm-1",
      },
    ],
    totals: {
      tableSum: 2037.35,
      rentOwed: 2037.35,
      adjustment: 0,
      interest: 16.42,
      fee: 15,
      totalClaimed: 2068.77,
    },
    arrears: [{ month: "2026-08", dueDate: "2026-08-01", shortfall: 812.45 }],
    letterDate: "2026-11-18",
    deadline: "2026-12-04",
    deadlineDays: 16,
  };
}

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-please-change-0123456789";
  process.env.WEB_URL = "https://www.example.test";
});

beforeEach(() => {
  vi.resetModules();
  getUserPropertyRole.mockReset();
  getAccessiblePropertyIds.mockReset().mockResolvedValue(["prop-1"]);
  generateFormalNotice.mockReset().mockResolvedValue(okResult());
  selectQueue.length = 0;
});

async function paymentsApp(opts: { tokenScope?: "read" | "write"; tokenId?: string } = {}) {
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

/** The lease the handler looks up, on a property the caller can reach. */
function leaseOnProperty(propertyId = "prop-1") {
  selectQueue.push([{ propertyId }]);
}

async function generate(
  body: unknown,
  opts: { tokenScope?: "read" | "write"; tokenId?: string } = {},
) {
  const app = await paymentsApp(opts);
  return app.request("/payments/formal-notice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /payments/formal-notice: the answer to an authorised manager", () => {
  it("returns the letters, the totals and the deadline in one JSON envelope (D-31)", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.letters).toHaveLength(1);
    expect(body.data.letters[0].recipientName).toBe("Łukasz Wójcik");
    expect(Buffer.from(body.data.letters[0].pdfBase64, "base64").subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(body.data.totals).toMatchObject({
      rentOwed: 2037.35,
      interest: 16.42,
      fee: 15,
      totalClaimed: 2068.77,
      currency: "EUR",
    });
    expect(body.data.arrears).toHaveLength(1);
    expect(body.data.letterDate).toBe("2026-11-18");
    expect(body.data.deadline).toBe("2026-12-04");
    expect(body.data.deadlineDays).toBe(16);
  });

  it("lets an owner generate one too", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1", deadlineDays: 30 });
    expect(res.status).toBe(200);
    expect(generateFormalNotice).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", deadlineDays: 30 }),
    );
  });

  it("passes the landlord's own paragraph on", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    await generate({ leaseId: "lease-1", extraParagraph: "Ik heb u al gebeld." });
    expect(generateFormalNotice.mock.calls[0]![0]).toMatchObject({
      extraParagraph: "Ik heb u al gebeld.",
    });
  });
});

describe("POST /payments/formal-notice: who is refused (T-11.2-18, T-11.2-19, T-11.2-20)", () => {
  it("refuses a viewer and never reaches the service", async () => {
    getUserPropertyRole.mockResolvedValue("viewer");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(403);
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });

  it("refuses an accountant and never reaches the service", async () => {
    getUserPropertyRole.mockResolvedValue("accountant");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(403);
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });

  it("refuses a contract on a property the caller cannot reach", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    leaseOnProperty("prop-9");
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });

  it("refuses a caller with access but no role on the property", async () => {
    getUserPropertyRole.mockResolvedValue(null);
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(403);
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown contract", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    const res = await generate({ leaseId: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Lease not found" });
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });

  it("refuses a read-scoped API token before the handler runs", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" }, { tokenScope: "read", tokenId: "tok-1" });
    expect(res.status).toBe(403);
    expect(generateFormalNotice).not.toHaveBeenCalled();
  });
});

describe("POST /payments/formal-notice: how the letter is recorded as triggered", () => {
  it("marks a write-scoped token call as api", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1" }, { tokenScope: "write", tokenId: "tok-1" });
    expect(res.status).toBe(200);
    expect(generateFormalNotice.mock.calls[0]![0]).toMatchObject({
      trigger: { trigger: "api", triggeredBy: "user-A" },
    });
  });

  it("marks a session call as manual", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    await generate({ leaseId: "lease-1" });
    expect(generateFormalNotice.mock.calls[0]![0]).toMatchObject({
      trigger: { trigger: "manual", triggeredBy: "user-A" },
    });
  });
});

describe("POST /payments/formal-notice: bounded input (T-11.2-21)", () => {
  const cases: Array<[string, unknown]> = [
    ["no lease id", {}],
    ["an empty lease id", { leaseId: "" }],
    ["an oversized lease id", { leaseId: "x".repeat(65) }],
    ["a deadline of zero days", { leaseId: "lease-1", deadlineDays: 0 }],
    ["a deadline beyond ninety days", { leaseId: "lease-1", deadlineDays: 91 }],
    ["a fractional deadline", { leaseId: "lease-1", deadlineDays: 1.5 }],
    ["a deadline sent as text", { leaseId: "lease-1", deadlineDays: "16" }],
    ["a paragraph over two thousand characters", { leaseId: "lease-1", extraParagraph: "x".repeat(2001) }],
  ];

  for (const [name, body] of cases) {
    it(`refuses ${name}`, async () => {
      getUserPropertyRole.mockResolvedValue("manager");
      leaseOnProperty();
      const res = await generate(body);
      expect(res.status).toBe(400);
      expect(generateFormalNotice).not.toHaveBeenCalled();
    });
  }

  it("accepts a paragraph of exactly two thousand characters", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    const res = await generate({ leaseId: "lease-1", extraParagraph: "x".repeat(2000) });
    expect(res.status).toBe(200);
  });
});

describe("POST /payments/formal-notice: refusals from the service", () => {
  const codes = ["missing_sender_address", "nothing_owed", "missing_bank_account", "no_tenant"] as const;

  for (const code of codes) {
    it(`passes ${code} through as a 400 with its code`, async () => {
      getUserPropertyRole.mockResolvedValue("manager");
      leaseOnProperty();
      generateFormalNotice.mockResolvedValue({ ok: false, error: `cannot: ${code}`, code });
      const res = await generate({ leaseId: "lease-1" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `cannot: ${code}`, code });
    });
  }

  it("answers 500 without leaking the exception when the service throws", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    leaseOnProperty();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    generateFormalNotice.mockRejectedValue(new Error("pdfkit exploded at /srv/rentular/x.ttf"));
    const res = await generate({ leaseId: "lease-1" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not generate the formal notice" });
    error.mockRestore();
  });
});
