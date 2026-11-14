/**
 * GoCardless client resolution: on a hosted install each landlord's lease uses
 * that landlord's own token and creditor, a landlord without a connection gets
 * GOCARDLESS_NOT_CONNECTED, and the instance token is never read. Self-hosted
 * keeps the instance token, with GOCARDLESS_CREDITOR_ID choosing the creditor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const credentials: Record<string, { accessToken: string; environment: "sandbox" | "live"; organisationId: string; creditorId: string | null }> = {
  "landlord-a": { accessToken: "TOKEN-A", environment: "live", organisationId: "OR-A", creditorId: "CR-A2" },
};

vi.mock("../gocardlessConnections", () => ({
  loadActiveCredentials: vi.fn(async (ownerId: string) => credentials[ownerId] ?? null),
}));

import {
  createPayment,
  getCreditorInfo,
  getGoCardlessAvailability,
  getGoCardlessClientFor,
  GoCardlessUnavailableError,
  selectCreditor,
  setGoCardlessClientFactory,
  type GoCardlessClient,
} from "../gocardless";

type Built = { token: string; environment: string; client: GoCardlessClient };
let built: Built[] = [];
let creditorsByToken: Record<string, Array<{ id: string; name?: string; scheme_identifiers?: Array<{ scheme: string }> }>> = {};
const paymentCreates: Array<{ token: string; params: Record<string, unknown> }> = [];

function fakeFactory(token: string, environment: "sandbox" | "live"): GoCardlessClient {
  const client = {
    customers: { create: vi.fn(async () => ({ id: "CU1" })) },
    billingRequests: { create: vi.fn(async () => ({ id: "BRQ1" })) },
    billingRequestFlows: { create: vi.fn(async () => ({ id: "BRF1", authorisation_url: "https://pay" })) },
    mandates: { get: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})) },
    payments: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        paymentCreates.push({ token, params });
        return { id: "PM1", status: "pending_submission", charge_date: "2026-12-01" };
      }),
      retry: vi.fn(async () => ({})),
      cancel: vi.fn(async () => ({})),
      list: vi.fn(async () => ({})),
    },
    creditors: { list: vi.fn(async () => ({ creditors: creditorsByToken[token] ?? [] })) },
  } as unknown as GoCardlessClient;
  built.push({ token, environment, client });
  return client;
}

const ORIGINAL_ENV = process.env;
let envTokenReads = 0;

/** process.env with a spy on GOCARDLESS_ACCESS_TOKEN reads. */
function useEnv(values: Record<string, string | undefined>) {
  const target: Record<string, string | undefined> = { ...ORIGINAL_ENV, ...values };
  process.env = new Proxy(target, {
    get(t, prop: string) {
      if (prop === "GOCARDLESS_ACCESS_TOKEN") envTokenReads++;
      return t[prop];
    },
  }) as NodeJS.ProcessEnv;
}

beforeEach(() => {
  built = [];
  paymentCreates.length = 0;
  envTokenReads = 0;
  creditorsByToken = {
    "TOKEN-A": [
      { id: "CR-A1", name: "A first", scheme_identifiers: [{ scheme: "sepa_core" }] },
      { id: "CR-A2", name: "A Vastgoed", scheme_identifiers: [{ scheme: "sepa_core" }] },
    ],
    "ENV-TOKEN": [
      { id: "CR-ENV1", name: "Self first" },
      { id: "CR-ENV2", name: "Self second" },
    ],
  };
  setGoCardlessClientFactory(fakeFactory);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  setGoCardlessClientFactory(null);
});

describe("hosted install", () => {
  beforeEach(() => {
    useEnv({
      RENTULAR_INSTANCE: "hosted",
      GOCARDLESS_ACCESS_TOKEN: "ENV-TOKEN",
      GOCARDLESS_PARTNER_CLIENT_ID: "client",
      GOCARDLESS_PARTNER_CLIENT_SECRET: "secret",
    });
  });

  it("uses landlord A's own token and creditor for A's lease", async () => {
    const resolved = await getGoCardlessClientFor({ ownerId: "landlord-a" });
    expect(resolved.source).toBe("account");
    expect(built.map((b) => b.token)).toEqual(["TOKEN-A"]);
    expect(built[0].environment).toBe("live");

    const creditor = await getCreditorInfo({ ownerId: "landlord-a" });
    expect(creditor).toEqual({ creditorId: "CR-A2", name: "A Vastgoed", scheme: "sepa_core" });

    await createPayment({ ownerId: "landlord-a" }, { mandateId: "MD-A", amount: 850.5, description: "Rent" });
    expect(paymentCreates).toHaveLength(1);
    expect(paymentCreates[0].token).toBe("TOKEN-A");
    expect(paymentCreates[0].params.amount).toBe(85050);
    expect(paymentCreates[0].params).not.toHaveProperty("app_fee");
  });

  it("gives landlord B without a connection GOCARDLESS_NOT_CONNECTED", async () => {
    await expect(getGoCardlessClientFor({ ownerId: "landlord-b" })).rejects.toMatchObject({
      code: "GOCARDLESS_NOT_CONNECTED",
    });
    await expect(
      createPayment({ ownerId: "landlord-b" }, { mandateId: "MD-B", amount: 1, description: "Rent" })
    ).rejects.toBeInstanceOf(GoCardlessUnavailableError);
    const availability = await getGoCardlessAvailability({ ownerId: "landlord-b" });
    expect(availability).toEqual({ available: false, code: "GOCARDLESS_NOT_CONNECTED", mode: "partner" });
    expect(built).toHaveLength(0);
  });

  it("never reads the instance token", async () => {
    await getGoCardlessClientFor({ ownerId: "landlord-a" });
    await getCreditorInfo({ ownerId: "landlord-a" });
    await getGoCardlessAvailability({ ownerId: "landlord-b" });
    await expect(getGoCardlessClientFor({ ownerId: "landlord-b" })).rejects.toThrow();
    expect(envTokenReads).toBe(0);
    expect(built.some((b) => b.token === "ENV-TOKEN")).toBe(false);
  });

  it("is unavailable without partner credentials, even with an instance token", async () => {
    useEnv({ RENTULAR_INSTANCE: "hosted", GOCARDLESS_ACCESS_TOKEN: "ENV-TOKEN" });
    await expect(getGoCardlessClientFor({ ownerId: "landlord-a" })).rejects.toMatchObject({
      code: "GOCARDLESS_PARTNER_NOT_CONFIGURED",
    });
    expect(envTokenReads).toBe(0);
  });
});

describe("self-hosted install", () => {
  it("uses the instance token for any landlord", async () => {
    useEnv({ RENTULAR_INSTANCE: "self", GOCARDLESS_ACCESS_TOKEN: "ENV-TOKEN", GOCARDLESS_ENVIRONMENT: "sandbox" });
    const resolved = await getGoCardlessClientFor({ ownerId: "whoever" });
    expect(resolved.source).toBe("instance");
    expect(built[0]).toMatchObject({ token: "ENV-TOKEN", environment: "sandbox" });
  });

  it("picks the creditor named in GOCARDLESS_CREDITOR_ID", async () => {
    useEnv({ RENTULAR_INSTANCE: "self", GOCARDLESS_ACCESS_TOKEN: "ENV-TOKEN", GOCARDLESS_CREDITOR_ID: "CR-ENV2" });
    const creditor = await getCreditorInfo({ ownerId: "whoever" });
    expect(creditor?.creditorId).toBe("CR-ENV2");
  });

  it("falls back to the first creditor with a log line when several exist", async () => {
    useEnv({ RENTULAR_INSTANCE: "self", GOCARDLESS_ACCESS_TOKEN: "ENV-TOKEN", GOCARDLESS_CREDITOR_ID: undefined });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const creditor = await getCreditorInfo({ ownerId: "whoever" });
    expect(creditor?.creditorId).toBe("CR-ENV1");
    expect(log.mock.calls.some((args) => String(args[0]).includes("GOCARDLESS_CREDITOR_ID"))).toBe(true);
    log.mockRestore();
  });

  it("reports GOCARDLESS_NOT_CONFIGURED without a token", async () => {
    useEnv({ RENTULAR_INSTANCE: "self", GOCARDLESS_ACCESS_TOKEN: undefined });
    await expect(getGoCardlessClientFor({ ownerId: "x" })).rejects.toMatchObject({ code: "GOCARDLESS_NOT_CONFIGURED" });
  });
});

describe("selectCreditor", () => {
  it("prefers the given id and otherwise takes the first", () => {
    const list = [{ id: "1" }, { id: "2" }];
    expect(selectCreditor(list, "2")).toEqual({ creditor: { id: "2" }, matchedPreferred: true });
    expect(selectCreditor(list, "9")).toEqual({ creditor: { id: "1" }, matchedPreferred: false });
    expect(selectCreditor([], null)).toEqual({ creditor: null, matchedPreferred: false });
  });
});
