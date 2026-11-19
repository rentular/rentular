/**
 * Route tests for POST /api/v1/communications/:id/posted (D-20).
 *
 * The posting date of a registered formal notice is the legal anchor: the
 * deadline in the letter runs from the day it was handed in at the post
 * office, and the landlord records that day afterwards. So these tests pin
 * three things that matter in a dispute:
 *
 *   1. sentAt is the submitted day, never the moment of the request.
 *   2. Only a manager or higher on the letter's property can record or
 *      correct it, and a correction keeps the previous record.
 *   3. An implausible date (future, before the letter existed, not a date)
 *      is refused rather than stored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PropertyManagerRole } from "@rentular/shared";

// --- property access -----------------------------------------------------

const getAccessiblePropertyIds = vi.fn(async () => ["prop-1"]);
const getUserPropertyRole = vi.fn();
const ROLE_LEVEL: Record<string, number> = { viewer: 1, accountant: 2, manager: 3, co_owner: 4, owner: 5 };
function hasMinimumRole(role: PropertyManagerRole, min: PropertyManagerRole): boolean {
  return (ROLE_LEVEL[role] ?? 0) >= (ROLE_LEVEL[min] ?? Infinity);
}
vi.mock("../../lib/propertyAccess", () => ({
  getAccessiblePropertyIds,
  getAccessiblePropertyIdsForRole: vi.fn(async () => ["prop-1"]),
  getUserPropertyRole,
  hasMinimumRole,
  requirePropertyAccess: vi.fn(),
  canAccessDomain: vi.fn(() => true),
  ROLE_LEVEL,
}));

// --- queues and recipients (module side effects otherwise open Redis) ----

vi.mock("../../jobs/emailQueueWorker", () => ({ queueEmail: vi.fn() }));
vi.mock("../../jobs/smsQueueWorker", () => ({ queueSms: vi.fn() }));
vi.mock("../../lib/leaseRecipients", () => ({ getLeaseEmailRecipients: vi.fn(), mergeCc: vi.fn() }));

// --- timezone: "today" is fixed so a backdated posting stays backdated ---

vi.mock("../../lib/timezone", () => ({
  DEFAULT_TIMEZONE: "Europe/Brussels",
  getScheduleTimezone: () => "Europe/Brussels",
  todayInZone: () => "2026-11-24",
  ymdInZone: (at: Date) => new Date(at).toISOString().slice(0, 10),
  resolveTimezone: () => "Europe/Brussels",
  dayOfMonthInZone: (at: Date) => new Date(at).getUTCDate(),
  toUtcIso: (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v)),
}));

// --- database ------------------------------------------------------------

/** Rows the next selects return, in order. */
const selectQueue: unknown[][] = [];
/** Every object handed to db.update(...).set(...). */
const updateSets: Record<string, unknown>[] = [];

function chain(kind: "select" | "update" | "insert" | "delete"): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = Promise.resolve(kind === "select" ? (selectQueue.shift() ?? []) : []);
        return r.then.bind(r);
      }
      if (prop === "set") {
        return (obj: Record<string, unknown>) => {
          updateSets.push(obj);
          return chain(kind);
        };
      }
      return () => chain(kind);
    },
  });
}

vi.mock("@rentular/db", () => ({
  getDb: vi.fn(() => ({
    select: () => chain("select"),
    insert: () => chain("insert"),
    update: () => chain("update"),
    delete: () => chain("delete"),
  })),
  communications: { id: "id", ownerId: "owner_id", leaseId: "lease_id", __table: "communications" },
  leases: { id: "id", propertyId: "property_id", __table: "leases" },
  leaseTenants: { leaseId: "lease_id", __table: "lease_tenants" },
}));

vi.mock("drizzle-orm", () => {
  const f = vi.fn((...a: unknown[]) => ({ a }));
  return { eq: f, and: f, desc: f, inArray: f, or: f, sql: f, lt: f, gte: f, lte: f, isNull: f, isNotNull: f, like: f };
});

// --- fixtures ------------------------------------------------------------

const LETTER = {
  id: "comm-1",
  ownerId: "owner-1",
  leaseId: "lease-1",
  channel: "letter",
  type: "formal_notice",
  status: "queued",
  recipientName: "Jan Peeters",
  recipientEmail: null,
  recipientPhone: null,
  subject: "Ingebrekestelling",
  body: "Letter body",
  errorMessage: null,
  externalId: null,
  metadata: { deadline: "2026-12-04", arrears: ["2026-10", "2026-11"], totalClaimed: 1560 },
  sentAt: null,
  createdAt: new Date("2026-11-18T09:00:00Z"),
};

/** The communication row, then the lease row its property check reads. */
function queueLetter(row: Record<string, unknown> = {}) {
  selectQueue.push([{ ...LETTER, ...row }]);
  selectQueue.push([{ propertyId: "prop-1" }]);
}

beforeEach(() => {
  vi.resetModules();
  getUserPropertyRole.mockReset();
  selectQueue.length = 0;
  updateSets.length = 0;
});

async function commsApp(opts: { tokenScope?: "read" | "write"; userId?: string } = {}) {
  const { communicationsRouter } = await import("../communications");
  const { requireWriteScope } = await import("../../lib/routeAuth");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", opts.userId ?? "user-A");
    c.set("tokenScope", opts.tokenScope ?? null);
    c.set("tokenId", null);
    await next();
  });
  app.use("/communications/*", requireWriteScope);
  app.route("/communications", communicationsRouter);
  return app;
}

function markPosted(app: Hono, id: string, body: unknown) {
  return app.request(`/communications/${id}/posted`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- the happy path ------------------------------------------------------

describe("POST /communications/:id/posted", () => {
  it("records a backdated posting day and the registered-item reference", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", {
      postedOn: "2026-11-20",
      reference: "010541234567890123456789",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: "comm-1",
        status: "sent",
        sentAt: "2026-11-20T12:00:00.000Z",
        postedOn: "2026-11-20",
        reference: "010541234567890123456789",
      },
    });

    expect(updateSets).toHaveLength(1);
    const set = updateSets[0];
    expect(set.status).toBe("sent");
    // The day the landlord walked to the post office, not the day of the request.
    expect((set.sentAt as Date).toISOString()).toBe("2026-11-20T12:00:00.000Z");
    expect(set.externalId).toBe("010541234567890123456789");
    expect(set.errorMessage).toBeNull();
    expect(set.metadata).toMatchObject({
      postedOn: "2026-11-20",
      postedBy: "user-A",
      deadline: "2026-12-04",
      arrears: ["2026-10", "2026-11"],
      totalClaimed: 1560,
    });
  });

  it("accepts a posting without a reference and stores no external id", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { reference: null } });
    expect(updateSets[0].externalId).toBeNull();
  });

  it("keeps the previous date and reference when a mistyped posting is corrected", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter({
      status: "sent",
      externalId: "010500000000000000000000",
      sentAt: new Date("2026-11-19T12:00:00Z"),
      metadata: { ...LETTER.metadata, postedOn: "2026-11-19", postedBy: "user-A" },
    });
    const res = await markPosted(await commsApp(), "comm-1", {
      postedOn: "2026-11-20",
      reference: "010541234567890123456789",
    });
    expect(res.status).toBe(200);
    const meta = updateSets[0].metadata as Record<string, unknown>;
    expect(meta.postedOn).toBe("2026-11-20");
    expect(meta.postedHistory).toEqual([{ postedOn: "2026-11-19", reference: "010500000000000000000000" }]);
  });

  it("lets the owner of a letter without a contract mark it", async () => {
    selectQueue.push([{ ...LETTER, leaseId: null, ownerId: "user-A" }]);
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(getUserPropertyRole).not.toHaveBeenCalled();
  });

  it("lets an owner on the property mark it", async () => {
    getUserPropertyRole.mockResolvedValue("owner");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(200);
  });
});

// --- who may not ---------------------------------------------------------

describe("POST /communications/:id/posted access", () => {
  it.each(["viewer", "accountant"])("refuses a %s on the property", async (role) => {
    getUserPropertyRole.mockResolvedValue(role);
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(403);
    expect(updateSets).toHaveLength(0);
  });

  it("refuses another landlord's communication", async () => {
    getUserPropertyRole.mockResolvedValue(null);
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Insufficient permissions" });
    expect(updateSets).toHaveLength(0);
  });

  it("refuses a letter without a contract owned by someone else", async () => {
    selectQueue.push([{ ...LETTER, leaseId: null, ownerId: "owner-Z" }]);
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(403);
    expect(updateSets).toHaveLength(0);
  });

  it("returns 404 for an unknown id", async () => {
    selectQueue.push([]);
    const res = await markPosted(await commsApp(), "nope", { postedOn: "2026-11-20" });
    expect(res.status).toBe(404);
    expect(updateSets).toHaveLength(0);
  });

  it("returns 404 when the linked contract is gone", async () => {
    selectQueue.push([{ ...LETTER }]);
    selectQueue.push([]);
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(404);
    expect(updateSets).toHaveLength(0);
  });

  it("refuses a read-only API token", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp({ tokenScope: "read" }), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Token is read-only" });
    expect(updateSets).toHaveLength(0);
  });
});

// --- what may not be marked ---------------------------------------------

describe("POST /communications/:id/posted validation", () => {
  it("refuses a channel that is not a letter", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter({ channel: "email", type: "payment_reminder_friendly" });
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "not_a_letter" });
    expect(updateSets).toHaveLength(0);
  });

  it.each([
    ["a day after today", "2026-11-25"],
    ["a day before the letter existed", "2026-11-17"],
    ["a day that is not on the calendar", "2026-02-30"],
  ])("refuses %s", async (_label, postedOn) => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_posted_date" });
    expect(updateSets).toHaveLength(0);
  });

  it("accepts today itself", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-24" });
    expect(res.status).toBe(200);
  });

  it("refuses a date in the Belgian display format", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "20/11/2026" });
    expect(res.status).toBe(400);
    expect(updateSets).toHaveLength(0);
  });

  it("refuses a reference longer than the column allows", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter();
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20", reference: "x".repeat(65) });
    expect(res.status).toBe(400);
    expect(updateSets).toHaveLength(0);
  });

  it("refuses a letter that is neither queued nor already posted", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queueLetter({ status: "failed" });
    const res = await markPosted(await commsApp(), "comm-1", { postedOn: "2026-11-20" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "not_markable" });
    expect(updateSets).toHaveLength(0);
  });
});
