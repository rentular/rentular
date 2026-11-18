/**
 * Route tests for the tenant correspondence address (D-12): the address the
 * formal notice is posted to when it differs from the rented property.
 *
 * Two things are worth pinning here. Input is bounded to the column widths, so
 * an oversized value is a 400 rather than a truncated row. And the PATCH
 * authorisation chain stays in front of the write: the tenant has to be linked
 * by a lease to a property the caller can reach, and the caller needs manager
 * or higher, which is the control the 2026-09 bankAccounts IDOR lacked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PropertyManagerRole } from "@rentular/shared";

const getAccessiblePropertyIds = vi.fn(async () => ["prop-1"]);
const getUserPropertyRole = vi.fn();
const ROLE_LEVEL: Record<string, number> = { viewer: 1, accountant: 2, manager: 3, co_owner: 4, owner: 5 };
function hasMinimumRole(role: PropertyManagerRole, min: PropertyManagerRole): boolean {
  return (ROLE_LEVEL[role] ?? 0) >= (ROLE_LEVEL[min] ?? Infinity);
}
const canAccessDomain = vi.fn(() => true);
vi.mock("../../lib/propertyAccess", () => ({
  getAccessiblePropertyIds,
  getUserPropertyRole,
  hasMinimumRole,
  canAccessDomain,
  ROLE_LEVEL,
}));

vi.mock("../../services/tenantBankAccounts", () => ({
  normalizeIban: (s: string) => s.replace(/\s+/g, "").toUpperCase(),
}));

/** Rows the next db.select() resolves to, in call order. */
const selectQueue: unknown[][] = [];
/** Every object handed to db.insert(...).values(...). */
const insertValues: Record<string, unknown>[] = [];
/** Every object handed to db.update(...).set(...). */
const updateSets: Record<string, unknown>[] = [];

function chain(kind: "select" | "update" | "insert" | "delete"): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        const rows = kind === "select" ? selectQueue.shift() ?? [] : [];
        const r = Promise.resolve(rows);
        return r.then.bind(r);
      }
      return (...args: unknown[]) => {
        if (kind === "insert" && prop === "values") {
          insertValues.push(args[0] as Record<string, unknown>);
        }
        if (kind === "update" && prop === "set") {
          updateSets.push(args[0] as Record<string, unknown>);
        }
        return chain(kind);
      };
    },
  });
}

vi.mock("@rentular/db", () => ({
  getDb: vi.fn(() => ({
    select: () => chain("select"),
    update: () => chain("update"),
    insert: () => chain("insert"),
    delete: () => chain("delete"),
  })),
  tenants: {},
  tenantBankAccounts: {},
  leases: {},
  leaseTenants: {},
  propertyManagers: {},
}));

vi.mock("drizzle-orm", () => {
  const f = vi.fn((...a: unknown[]) => ({ a }));
  return { eq: f, and: f, desc: f, lt: f, gte: f, lte: f, inArray: f, like: f, sql: f, isNotNull: f, isNull: f };
});

const TENANT = { id: "tenant-1", ownerId: "user-A", firstName: "Angele", lastName: "Peeters", iban: null };

beforeEach(() => {
  selectQueue.length = 0;
  insertValues.length = 0;
  updateSets.length = 0;
  getUserPropertyRole.mockReset();
  getAccessiblePropertyIds.mockClear();
});

async function tenantsApp() {
  const { tenantsRouter } = await import("../tenants");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "user-A");
    c.set("tokenScope", null);
    await next();
  });
  app.route("/tenants", tenantsRouter);
  return app;
}

function send(app: Hono, method: "POST" | "PATCH", path: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Queue the selects the PATCH authorisation chain and response make. */
function queuePatchSelects() {
  selectQueue.push([TENANT]); // the tenant being patched
  selectQueue.push([{ leaseId: "lease-1" }]); // leases linking the tenant
  selectQueue.push([{ id: "lease-1", propertyId: "prop-1" }]); // accessible of those
  selectQueue.push([TENANT]); // re-read for the response
  selectQueue.push([]); // bank accounts for the response
}

describe("POST /tenants correspondence address", () => {
  it("inserts the address that was given", async () => {
    const res = await send(await tenantsApp(), "POST", "/tenants", {
      firstName: "Angele",
      lastName: "Peeters",
      email: "angele@example.test",
      correspondenceStreet: "Tervuursestraat",
      correspondenceStreetNumber: "97",
      correspondencePostalCode: "3000",
      correspondenceCity: "Leuven",
    });

    expect(res.status).toBe(201);
    expect(insertValues[0]).toMatchObject({
      correspondenceStreet: "Tervuursestraat",
      correspondenceStreetNumber: "97",
      correspondenceBox: null,
      correspondencePostalCode: "3000",
      correspondenceCity: "Leuven",
      correspondenceCountry: null,
    });
  });

  it("inserts null for every address column when none is given", async () => {
    const res = await send(await tenantsApp(), "POST", "/tenants", {
      firstName: "Angele",
      lastName: "Peeters",
      email: "angele@example.test",
    });

    expect(res.status).toBe(201);
    for (const key of [
      "correspondenceStreet",
      "correspondenceStreetNumber",
      "correspondenceBox",
      "correspondencePostalCode",
      "correspondenceCity",
      "correspondenceCountry",
    ]) {
      expect(insertValues[0][key]).toBeNull();
    }
  });
});

describe("PATCH /tenants/:id correspondence address", () => {
  it("stores a value a manager sends and upper-cases the country", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queuePatchSelects();

    const res = await send(await tenantsApp(), "PATCH", "/tenants/tenant-1", {
      correspondenceStreet: "Naamsestraat",
      correspondenceCountry: "nl",
    });

    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      correspondenceStreet: "Naamsestraat",
      correspondenceCountry: "NL",
    });
  });

  it("clears a column when an empty string is sent", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queuePatchSelects();

    const res = await send(await tenantsApp(), "PATCH", "/tenants/tenant-1", {
      correspondenceStreet: "",
      correspondenceCountry: "",
    });

    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0].correspondenceStreet).toBeNull();
    expect(updateSets[0].correspondenceCountry).toBeNull();
  });

  it("refuses a viewer and writes nothing", async () => {
    getUserPropertyRole.mockResolvedValue("viewer");
    queuePatchSelects();

    const res = await send(await tenantsApp(), "PATCH", "/tenants/tenant-1", {
      correspondenceStreet: "Naamsestraat",
    });

    expect(res.status).toBe(403);
    expect(updateSets).toHaveLength(0);
  });

  it("rejects a value wider than the column before touching the database", async () => {
    getUserPropertyRole.mockResolvedValue("manager");
    queuePatchSelects();

    const res = await send(await tenantsApp(), "PATCH", "/tenants/tenant-1", {
      correspondenceStreet: "x".repeat(256),
    });

    expect(res.status).toBe(400);
    expect(updateSets).toHaveLength(0);
  });
});
