import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";

/** Rows the next db.select() resolves to. */
const selectQueue: unknown[][] = [];
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
  users: {},
  smtpSettings: {},
  paymentFollowUpSettings: {},
  communications: {},
  eq: vi.fn(),
}));

vi.mock("drizzle-orm", () => {
  const f = vi.fn((...a: unknown[]) => ({ a }));
  return { eq: f, and: f, desc: f, lt: f, gte: f, lte: f, inArray: f, like: f, sql: f, isNotNull: f, isNull: f };
});

vi.mock("bullmq", () => {
  class MockQueue {
    add = vi.fn().mockResolvedValue({ id: "j" });
    constructor() {}
  }
  class MockWorker {
    on = vi.fn();
    constructor(..._args: unknown[]) {}
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock("../../lib/email", () => ({
  sendEmail: vi.fn(),
  renderTemplate: vi.fn((t: string) => t),
  getTransportForOwner: vi.fn(),
  clearTransportCache: vi.fn(),
}));

vi.mock("../../lib/sms", () => ({
  sendSms: vi.fn(),
  normalizePhoneNumber: vi.fn((p: string) => p),
  toE164: vi.fn((p: string) => p),
}));

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-please-change-0123456789";
});

beforeEach(() => {
  selectQueue.length = 0;
  updateSets.length = 0;
});

async function settingsApp() {
  const { settingsRouter } = await import("../settings");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "user-A");
    c.set("tokenScope", null);
    await next();
  });
  app.route("/settings", settingsRouter);
  return app;
}

function put(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /settings/profile postal address (ARR, D-12)", () => {
  it("saves the six address fields and stores an empty box as null", async () => {
    const res = await put(await settingsApp(), "/settings/profile", {
      landlordType: "individual",
      street: "Tervuursestraat",
      streetNumber: "97",
      box: "",
      postalCode: "3000",
      city: "Leuven",
      country: "be",
    });

    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      street: "Tervuursestraat",
      streetNumber: "97",
      box: null,
      postalCode: "3000",
      city: "Leuven",
      country: "BE",
    });
    expect(await res.json()).toMatchObject({
      street: "Tervuursestraat",
      streetNumber: "97",
      box: null,
      postalCode: "3000",
      city: "Leuven",
      country: "BE",
    });
  });

  it("leaves the address columns alone when the body carries no address key", async () => {
    const res = await put(await settingsApp(), "/settings/profile", {
      landlordType: "company",
      vatNumber: "BE0123456789",
    });

    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    for (const key of ["street", "streetNumber", "box", "postalCode", "city", "country"]) {
      expect(updateSets[0]).not.toHaveProperty(key);
    }
  });

  it("rejects values wider than the columns", async () => {
    const app = await settingsApp();
    const base = { landlordType: "individual" as const };

    const longStreet = await put(app, "/settings/profile", { ...base, street: "x".repeat(256) });
    expect(longStreet.status).toBe(400);

    const longPostalCode = await put(app, "/settings/profile", { ...base, postalCode: "1".repeat(11) });
    expect(longPostalCode.status).toBe(400);

    const longCountry = await put(app, "/settings/profile", { ...base, country: "BEL" });
    expect(longCountry.status).toBe(400);

    expect(updateSets).toHaveLength(0);
  });
});

describe("GET /settings/profile postal address (ARR, D-12)", () => {
  it("returns the stored address", async () => {
    selectQueue.push([
      {
        landlordType: "individual",
        vatNumber: null,
        whatsappNumber: null,
        indexationAlertsEnabled: true,
        street: "Tervuursestraat",
        streetNumber: "97",
        box: "3",
        postalCode: "3000",
        city: "Leuven",
        country: "BE",
      },
    ]);

    const res = await (await settingsApp()).request("/settings/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      street: "Tervuursestraat",
      streetNumber: "97",
      box: "3",
      postalCode: "3000",
      city: "Leuven",
      country: "BE",
    });
  });

  it("returns empty strings for an address that was never filled in, with BE as the country", async () => {
    selectQueue.push([
      {
        landlordType: null,
        vatNumber: null,
        whatsappNumber: null,
        indexationAlertsEnabled: true,
        street: null,
        streetNumber: null,
        box: null,
        postalCode: null,
        city: null,
        country: null,
      },
    ]);

    const res = await (await settingsApp()).request("/settings/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      street: "",
      streetNumber: "",
      box: "",
      postalCode: "",
      city: "",
      country: "BE",
    });
  });
});

describe("SMS template fields in follow-up settings (NTF-05)", () => {
  it("should have SMS template fields in DEFAULT_SETTINGS", async () => {
    const { DEFAULT_SETTINGS } = await import("../../services/paymentFollowUp");

    expect(DEFAULT_SETTINGS).toHaveProperty("smsEnabled");
    expect(DEFAULT_SETTINGS).toHaveProperty("smsFriendlyMessage");
    expect(DEFAULT_SETTINGS).toHaveProperty("smsFormalMessage");
    expect(DEFAULT_SETTINGS).toHaveProperty("smsFinalMessage");
  });

  it("should have non-empty default SMS templates", async () => {
    const { DEFAULT_SETTINGS } = await import("../../services/paymentFollowUp");

    expect(DEFAULT_SETTINGS.smsFriendlyMessage.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.smsFormalMessage.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.smsFinalMessage.length).toBeGreaterThan(0);
  });

  it("should have SMS templates containing payment-related placeholders", async () => {
    const { DEFAULT_SETTINGS } = await import("../../services/paymentFollowUp");

    // All SMS templates should contain amount and property placeholders
    expect(DEFAULT_SETTINGS.smsFriendlyMessage).toContain("{{amount}}");
    expect(DEFAULT_SETTINGS.smsFormalMessage).toContain("{{amount}}");
    expect(DEFAULT_SETTINGS.smsFinalMessage).toContain("{{amount}}");
    expect(DEFAULT_SETTINGS.smsFriendlyMessage).toContain("{{propertyName}}");
  });

  it("should have all three email reminder levels", async () => {
    const { DEFAULT_SETTINGS } = await import("../../services/paymentFollowUp");

    expect(DEFAULT_SETTINGS.friendlySubject).toBeDefined();
    expect(DEFAULT_SETTINGS.friendlyBody).toBeDefined();
    expect(DEFAULT_SETTINGS.formalSubject).toBeDefined();
    expect(DEFAULT_SETTINGS.formalBody).toBeDefined();
    expect(DEFAULT_SETTINGS.finalSubject).toBeDefined();
    expect(DEFAULT_SETTINGS.finalBody).toBeDefined();
  });
});
