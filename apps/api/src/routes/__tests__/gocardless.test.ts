/**
 * GoCardless connect routes: the callback only accepts a valid state minted
 * for the GoCardless flow, the landlord's token is never returned by any
 * response, and webhooks on a hosted install are verified with the partner
 * secret.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { Hono } from "hono";

const LANDLORD_TOKEN = "live_LANDLORD-SECRET-TOKEN-123";

let storedRow: Record<string, any> | null = null;
const saved: Array<Record<string, unknown>> = [];

vi.mock("@rentular/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ email: "landlord@example.be", language: "nl" }] }),
      }),
    }),
  }),
  tenants: {},
  leases: {},
  properties: {},
  users: { email: "email", locale: "locale", id: "id" },
  gocardlessConnections: {},
  webhookEvents: {},
  payments: {},
}));

vi.mock("../../lib/gocardlessConnections", async () => {
  const actual = await vi.importActual<typeof import("../../lib/gocardlessConnections")>(
    "../../lib/gocardlessConnections"
  );
  return {
    ...actual,
    getConnectionStatus: vi.fn(async () => actual.toConnectionStatus(storedRow as any)),
    saveConnection: vi.fn(async (ownerId: string, input: Record<string, unknown>) => {
      saved.push({ ownerId, ...input });
      storedRow = {
        id: "c1",
        ownerId,
        organisationId: input.organisationId,
        creditorId: input.creditorId,
        creditorName: input.creditorName,
        accessTokenEncrypted: "CIPHERTEXT",
        accessTokenIv: "IV",
        accessTokenAuthTag: "TAG",
        environment: input.environment,
        scheme: input.scheme,
        status: "active",
        connectedAt: new Date("2026-11-14T10:00:00Z"),
        lastError: null,
        updatedAt: new Date(),
      };
    }),
    revokeConnection: vi.fn(async () => {
      if (storedRow) {
        storedRow = { ...storedRow, status: "revoked", accessTokenEncrypted: null, accessTokenIv: null, accessTokenAuthTag: null };
      }
    }),
    loadActiveCredentials: vi.fn(async () =>
      storedRow && storedRow.status === "active"
        ? { accessToken: LANDLORD_TOKEN, environment: "sandbox", organisationId: storedRow.organisationId, creditorId: null }
        : null
    ),
    ownerOfProperty: vi.fn(async () => "landlord-a"),
    findOwnerByOrganisation: vi.fn(async () => null),
  };
});

vi.mock("../../lib/propertyAccess", () => ({
  getUserPropertyRole: vi.fn(async () => "owner"),
  hasMinimumRole: () => true,
  getAccessiblePropertyIds: vi.fn(async () => []),
  getAccessiblePropertyIdsForRole: vi.fn(async () => []),
}));

const exchange = vi.fn();
const revokeAtGc = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../lib/gocardlessPartner", async () => {
  const actual = await vi.importActual<typeof import("../../lib/gocardlessPartner")>("../../lib/gocardlessPartner");
  return {
    ...actual,
    exchangeAuthorizationCode: (...a: unknown[]) => exchange(...a),
    revokeAccessToken: (...a: unknown[]) => revokeAtGc(...a),
  };
});

import { gocardlessRouter } from "../gocardless";
import { webhooksRouter, setWebhookStoreFactory } from "../webhooks";
import { signOAuthState } from "../../lib/bankOAuthState";
import { setGoCardlessClientFactory, type GoCardlessClient } from "../../lib/gocardless";
import type { WebhookStore } from "../../services/gocardlessWebhook";

const ORIGINAL_ENV = { ...process.env };

function app(userId: string | null = "landlord-a") {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, userId as never);
    await next();
  });
  a.route("/gocardless", gocardlessRouter);
  a.route("/webhooks", webhooksRouter);
  return a;
}

beforeEach(() => {
  storedRow = null;
  saved.length = 0;
  exchange.mockReset();
  process.env.AUTH_SECRET = "test-secret-please-change-0123456789";
  process.env.RENTULAR_INSTANCE = "hosted";
  process.env.WEB_URL = "https://www.rentular.com";
  process.env.GOCARDLESS_PARTNER_CLIENT_ID = "client-id";
  process.env.GOCARDLESS_PARTNER_CLIENT_SECRET = "client-secret";
  process.env.GOCARDLESS_PARTNER_WEBHOOK_SECRET = "partner-webhook-secret";
  process.env.GOCARDLESS_WEBHOOK_SECRET = "instance-webhook-secret";
  process.env.GOCARDLESS_ACCESS_TOKEN = "ENV-TOKEN";
  setGoCardlessClientFactory(
    () =>
      ({
        creditors: { list: async () => ({ creditors: [{ id: "CR-A", name: "A Vastgoed", scheme_identifiers: [{ scheme: "sepa_core" }] }] }) },
      }) as unknown as GoCardlessClient
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  setGoCardlessClientFactory(null);
  setWebhookStoreFactory(null);
});

async function connectWithValidState() {
  exchange.mockResolvedValue({ accessToken: LANDLORD_TOKEN, organisationId: "OR-A", email: null, scope: "read_write" });
  const state = await signOAuthState({ ownerId: "landlord-a", provider: "gocardless" });
  return app(null).request(`/gocardless/connect/callback?code=CODE&state=${encodeURIComponent(state)}`);
}

describe("connect callback", () => {
  it("stores the connection for the landlord in the state and redirects to settings", async () => {
    const res = await connectWithValidState();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://www.rentular.com/settings?tab=gocardless&gocardless=connected");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      ownerId: "landlord-a",
      organisationId: "OR-A",
      creditorId: "CR-A",
      creditorName: "A Vastgoed",
      environment: "sandbox",
    });
  });

  it("rejects a tampered state", async () => {
    const state = await signOAuthState({ ownerId: "landlord-a", provider: "gocardless" });
    const [h, p, s] = state.split(".");
    const forged = JSON.parse(Buffer.from(p, "base64url").toString());
    forged.ownerId = "landlord-b";
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`;
    const res = await app(null).request(`/gocardless/connect/callback?code=CODE&state=${encodeURIComponent(tampered)}`);
    expect(res.headers.get("location")).toContain("reason=expired_state");
    expect(exchange).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("rejects a valid state minted for another flow", async () => {
    const state = await signOAuthState({ ownerId: "landlord-a", provider: "enable_banking" });
    const res = await app(null).request(`/gocardless/connect/callback?code=CODE&state=${encodeURIComponent(state)}`);
    expect(res.headers.get("location")).toContain("reason=expired_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("does nothing on a self-hosted install", async () => {
    process.env.RENTULAR_INSTANCE = "self";
    const res = await connectWithValidState();
    expect(res.headers.get("location")).toContain("reason=not_available");
    expect(saved).toHaveLength(0);
  });
});

describe("disconnect", () => {
  it("revokes the token at GoCardless, then wipes it locally", async () => {
    await connectWithValidState();
    revokeAtGc.mockClear();
    const res = await app().request("/gocardless/disconnect", { method: "POST" });
    expect(res.status).toBe(200);
    expect(revokeAtGc).toHaveBeenCalledTimes(1);
    expect(revokeAtGc.mock.calls[0][1]).toBe(LANDLORD_TOKEN);
    expect(storedRow).toMatchObject({ status: "revoked", accessTokenEncrypted: null });
  });

  it("still wipes locally when the revoke call fails", async () => {
    await connectWithValidState();
    revokeAtGc.mockResolvedValueOnce(false);
    const res = await app().request("/gocardless/disconnect", { method: "POST" });
    expect(res.status).toBe(200);
    expect(storedRow).toMatchObject({ status: "revoked", accessTokenEncrypted: null });
  });
});

describe("the landlord's token never leaves the API", () => {
  it("is absent from callback, status, connect and disconnect responses", async () => {
    const bodies: string[] = [];
    const cb = await connectWithValidState();
    bodies.push(await cb.text(), cb.headers.get("location") || "");

    const status = await app().request("/gocardless/status");
    expect(status.status).toBe(200);
    const statusJson = await status.json();
    expect(statusJson.data.connection).toMatchObject({ connected: true, organisationId: "OR-A", creditorName: "A Vastgoed" });
    bodies.push(JSON.stringify(statusJson));

    const connect = await app().request("/gocardless/connect");
    expect(connect.status).toBe(200);
    const connectJson = await connect.json();
    expect(new URL(connectJson.data.url).searchParams.get("client_id")).toBe("client-id");
    bodies.push(JSON.stringify(connectJson));

    const disconnect = await app().request("/gocardless/disconnect", { method: "POST" });
    const disconnectJson = await disconnect.json();
    expect(disconnectJson.data.connected).toBe(false);
    bodies.push(JSON.stringify(disconnectJson));

    for (const body of bodies) {
      expect(body).not.toContain(LANDLORD_TOKEN);
      expect(body).not.toContain("ENV-TOKEN");
      expect(body).not.toContain("CIPHERTEXT");
      expect(body).not.toContain("client-secret");
    }
  });

  it("the self-hosted status does not include the instance token either", async () => {
    process.env.RENTULAR_INSTANCE = "self";
    const res = await app().request("/gocardless/status");
    const text = await res.text();
    expect(JSON.parse(text).data).toMatchObject({ mode: "instance", configured: true });
    expect(text).not.toContain("ENV-TOKEN");
    expect(text).not.toContain("ENV-TOKE");
  });
});

describe("webhook signature", () => {
  function signed(body: string, secret: string) {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("hosted verifies with the partner webhook secret", async () => {
    const processed: string[] = [];
    setWebhookStoreFactory(() => ({
      eventSeen: async () => false,
      recordEvent: async (row: { eventId: string; status: string }) => {
        processed.push(`${row.eventId}:${row.status}`);
      },
      markEvent: async () => undefined,
      ownerForOrganisation: async () => null,
    }) as unknown as WebhookStore);
    const body = JSON.stringify({
      events: [{ id: "EV1", resource_type: "payments", action: "confirmed", links: { payment: "PM1", organisation: "OR-Z" } }],
    });

    const wrong = await app(null).request("/webhooks/gocardless", {
      method: "POST",
      body,
      headers: { "Webhook-Signature": signed(body, "instance-webhook-secret") },
    });
    expect(wrong.status).toBe(401);

    const ok = await app(null).request("/webhooks/gocardless", {
      method: "POST",
      body,
      headers: { "Webhook-Signature": signed(body, "partner-webhook-secret") },
    });
    expect(ok.status).toBe(200);
    expect(processed).toEqual(["EV1:skipped"]);
  });

  it("self-hosted verifies with the instance webhook secret", async () => {
    process.env.RENTULAR_INSTANCE = "self";
    setWebhookStoreFactory(() => ({ eventSeen: async () => true }) as unknown as WebhookStore);
    const body = JSON.stringify({ events: [] });
    const res = await app(null).request("/webhooks/gocardless", {
      method: "POST",
      body,
      headers: { "Webhook-Signature": signed(body, "instance-webhook-secret") },
    });
    expect(res.status).toBe(200);
  });
});
