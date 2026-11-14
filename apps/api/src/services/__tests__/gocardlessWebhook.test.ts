/**
 * GoCardless webhook isolation: on a hosted install an event for
 * organisation A only ever touches landlord A's payments, leases and tenants.
 * Unknown organisations are recorded and ignored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@rentular/db", () => ({
  getDb: () => ({}),
  webhookEvents: {},
  payments: {},
  leases: {},
  tenants: {},
  properties: {},
}));
vi.mock("../../lib/gocardlessConnections", () => ({
  findOwnerByOrganisation: vi.fn(),
  revokeConnection: vi.fn(),
}));
vi.mock("../paymentStateMachine", async () => {
  const actual = await vi.importActual<typeof import("../paymentStateMachine")>("../paymentStateMachine");
  return { ...actual, transitionPayment: vi.fn() };
});

import { processGoCardlessEvent, type WebhookStore } from "../gocardlessWebhook";
import type { GoCardlessEvent } from "../../lib/gocardless";

interface Payment { id: string; ownerId: string; gcId: string; leaseId: string; status: string }
interface Lease { id: string; ownerId: string; mandateId: string | null; notes: string | null }
interface Tenant { id: string; ownerId: string; mandateId: string | null }

let payments: Payment[];
let leases: Lease[];
let tenants: Tenant[];
let events: Array<{ eventId: string; status: string }>;
let revoked: string[];
let inserted: Array<{ leaseId: string }>;

const orgs: Record<string, string> = { "OR-A": "landlord-a", "OR-B": "landlord-b" };

function memoryStore(): WebhookStore {
  const visible = <T extends { ownerId: string }>(rows: T[], owner: string | null) =>
    rows.filter((r) => owner === null || r.ownerId === owner);
  return {
    eventSeen: async (eventId) => events.some((e) => e.eventId === eventId),
    recordEvent: async (row) => {
      events.push({ eventId: row.eventId, status: row.status });
    },
    markEvent: async () => undefined,
    ownerForOrganisation: async (org) => orgs[org] ?? null,
    revokeOwner: async (ownerId) => {
      revoked.push(ownerId);
    },
    findPayment: async (gcId, owner) => visible(payments, owner).find((p) => p.gcId === gcId) ?? null,
    transitionPayment: async (id, status) => {
      const p = payments.find((x) => x.id === id);
      if (p) p.status = status;
      return true;
    },
    findLeaseForMandate: async (mandateId, owner) =>
      visible(leases, owner).find((l) => l.mandateId === mandateId) ?? null,
    insertPayment: async (row) => {
      inserted.push({ leaseId: row.leaseId });
    },
    leasesForMandate: async (mandateId, owner) =>
      visible(leases, owner).filter((l) => l.mandateId === mandateId).map((l) => ({ id: l.id, notes: l.notes })),
    cancelOpenPayments: async (leaseIds) => {
      let n = 0;
      for (const p of payments) {
        if (leaseIds.includes(p.leaseId) && (p.status === "pending" || p.status === "processing")) {
          p.status = "cancelled";
          n++;
        }
      }
      return n;
    },
    flagLease: async (leaseId, notes) => {
      const l = leases.find((x) => x.id === leaseId)!;
      l.notes = notes;
      l.mandateId = null;
    },
    clearTenantMandate: async (mandateId, owner) => {
      for (const t of visible(tenants, owner)) if (t.mandateId === mandateId) t.mandateId = null;
    },
  };
}

function event(partial: Partial<GoCardlessEvent> & { links: Record<string, string> }): GoCardlessEvent {
  return {
    id: partial.id ?? `EV-${Math.random()}`,
    created_at: "2026-11-14T10:00:00Z",
    resource_type: partial.resource_type ?? "payments",
    action: partial.action ?? "confirmed",
    links: partial.links,
    details: { origin: "gocardless", cause: "x", description: "x" },
  };
}

const hosted = (store: WebhookStore) => ({ hosted: true, store, today: () => "2026-11-14" });

beforeEach(() => {
  // Both landlords happen to have a mandate and payment with the same GoCardless
  // ids (ids are only unique per GoCardless account), which is the worst case.
  payments = [
    { id: "pa", ownerId: "landlord-a", gcId: "PM1", leaseId: "lease-a", status: "processing" },
    { id: "pb", ownerId: "landlord-b", gcId: "PM1", leaseId: "lease-b", status: "processing" },
    { id: "pb2", ownerId: "landlord-b", gcId: "PM2", leaseId: "lease-b", status: "pending" },
  ];
  leases = [
    { id: "lease-a", ownerId: "landlord-a", mandateId: "MD1", notes: null },
    { id: "lease-b", ownerId: "landlord-b", mandateId: "MD1", notes: null },
  ];
  tenants = [
    { id: "ta", ownerId: "landlord-a", mandateId: "MD1" },
    { id: "tb", ownerId: "landlord-b", mandateId: "MD1" },
  ];
  events = [];
  revoked = [];
  inserted = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("hosted webhook routing", () => {
  it("a payment event for organisation A only updates landlord A's payment", async () => {
    const out = await processGoCardlessEvent(
      event({ action: "confirmed", links: { payment: "PM1", organisation: "OR-A" } }),
      hosted(memoryStore())
    );
    expect(out).toBe("processed");
    expect(payments.find((p) => p.id === "pa")!.status).toBe("paid");
    expect(payments.find((p) => p.id === "pb")!.status).toBe("processing");
  });

  it("a payment event for organisation A cannot reach a payment only landlord B has", async () => {
    await processGoCardlessEvent(
      event({ action: "failed", links: { payment: "PM2", mandate: "MD-ONLY-B", organisation: "OR-A" } }),
      hosted(memoryStore())
    );
    expect(payments.find((p) => p.id === "pb2")!.status).toBe("pending");
    expect(inserted).toEqual([]);
  });

  it("a mandate cancellation for organisation A leaves landlord B's lease, tenant and payments alone", async () => {
    await processGoCardlessEvent(
      event({ resource_type: "mandates", action: "cancelled", links: { mandate: "MD1", organisation: "OR-A" } }),
      hosted(memoryStore())
    );
    expect(leases.find((l) => l.id === "lease-a")!.mandateId).toBeNull();
    expect(leases.find((l) => l.id === "lease-a")!.notes).toContain("SEPA collection stopped");
    expect(tenants.find((t) => t.id === "ta")!.mandateId).toBeNull();
    expect(payments.find((p) => p.id === "pa")!.status).toBe("cancelled");

    expect(leases.find((l) => l.id === "lease-b")).toMatchObject({ mandateId: "MD1", notes: null });
    expect(tenants.find((t) => t.id === "tb")!.mandateId).toBe("MD1");
    expect(payments.find((p) => p.id === "pb")!.status).toBe("processing");
    expect(payments.find((p) => p.id === "pb2")!.status).toBe("pending");
  });

  it("an unknown organisation is recorded as skipped and touches nothing", async () => {
    const before = JSON.stringify({ payments, leases, tenants });
    const out = await processGoCardlessEvent(
      event({ id: "EV-X", resource_type: "mandates", action: "cancelled", links: { mandate: "MD1", organisation: "OR-NOBODY" } }),
      hosted(memoryStore())
    );
    expect(out).toBe("skipped");
    expect(events).toEqual([{ eventId: "EV-X", status: "skipped" }]);
    expect(JSON.stringify({ payments, leases, tenants })).toBe(before);
  });

  it("an event without an organisation is ignored on a hosted install", async () => {
    const out = await processGoCardlessEvent(
      event({ action: "confirmed", links: { payment: "PM1" } }),
      hosted(memoryStore())
    );
    expect(out).toBe("skipped");
    expect(payments.every((p) => p.status !== "paid")).toBe(true);
  });

  it("a duplicate event is not applied twice", async () => {
    const store = memoryStore();
    const ev = event({ id: "EV-D", action: "confirmed", links: { payment: "PM1", organisation: "OR-A" } });
    expect(await processGoCardlessEvent(ev, hosted(store))).toBe("processed");
    expect(await processGoCardlessEvent(ev, hosted(store))).toBe("duplicate");
  });

  it("organisations.disconnected revokes that landlord's connection only", async () => {
    await processGoCardlessEvent(
      event({ resource_type: "organisations", action: "disconnected", links: { organisation: "OR-B" } }),
      hosted(memoryStore())
    );
    expect(revoked).toEqual(["landlord-b"]);
  });
});

describe("self-hosted webhook", () => {
  it("applies events without an organisation", async () => {
    payments = payments.filter((p) => p.ownerId === "landlord-a");
    const out = await processGoCardlessEvent(
      event({ action: "confirmed", links: { payment: "PM1" } }),
      { hosted: false, store: memoryStore(), today: () => "2026-11-14" }
    );
    expect(out).toBe("processed");
    expect(payments[0].status).toBe("paid");
  });
});
