import { describe, it, expect, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getPartnerConfig,
  getPartnerRedirectUri,
  PartnerOAuthError,
  type PartnerConfig,
} from "../gocardlessPartner";

const config: PartnerConfig = {
  clientId: "client-123",
  clientSecret: "super-secret-value",
  environment: "sandbox",
  redirectUri: "https://www.rentular.com/api/v1/gocardless/connect/callback",
};

describe("partner config", () => {
  it("is null without client id and secret", () => {
    expect(getPartnerConfig({ GOCARDLESS_PARTNER_CLIENT_ID: "x" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("derives the redirect from WEB_URL and defaults to sandbox", () => {
    const env = {
      GOCARDLESS_PARTNER_CLIENT_ID: "id",
      GOCARDLESS_PARTNER_CLIENT_SECRET: "s",
      WEB_URL: "https://www.rentular.com/",
    } as NodeJS.ProcessEnv;
    expect(getPartnerConfig(env)).toEqual({
      clientId: "id",
      clientSecret: "s",
      environment: "sandbox",
      redirectUri: "https://www.rentular.com/api/v1/gocardless/connect/callback",
    });
    expect(
      getPartnerRedirectUri({ GOCARDLESS_PARTNER_REDIRECT_URL: "https://x/cb" } as NodeJS.ProcessEnv)
    ).toBe("https://x/cb");
    expect(
      getPartnerConfig({ ...env, GOCARDLESS_PARTNER_ENVIRONMENT: "live" } as NodeJS.ProcessEnv)?.environment
    ).toBe("live");
  });
});

describe("authorize url", () => {
  it("asks for read_write on the right host with the state", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "STATE", email: "a@b.be", language: "nl" }));
    expect(url.origin).toBe("https://connect-sandbox.gocardless.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe("read_write");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("initial_view")).toBe("login");
    expect(url.searchParams.get("prefill[email]")).toBe("a@b.be");
    expect(url.toString()).not.toContain("super-secret-value");
  });

  it("uses the live host in live", () => {
    const url = new URL(buildAuthorizeUrl({ ...config, environment: "live" }, { state: "S", initialView: "signup" }));
    expect(url.origin).toBe("https://connect.gocardless.com");
    expect(url.searchParams.get("initial_view")).toBe("signup");
  });
});

describe("code exchange", () => {
  it("posts the code form encoded and returns token and organisation", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "LANDLORD-TOKEN", organisation_id: "OR123", email: "l@x.be", scope: "read_write" }),
        { status: 200 }
      )
    );
    const result = await exchangeAuthorizationCode(config, "CODE", fetchImpl);
    expect(result).toEqual({ accessToken: "LANDLORD-TOKEN", organisationId: "OR123", email: "l@x.be", scope: "read_write" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connect-sandbox.gocardless.com/oauth/access_token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("fails without leaking the client secret", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), { status: 400 })
    );
    const err = await exchangeAuthorizationCode(config, "OLD", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(PartnerOAuthError);
    expect(err.message).toBe("invalid_grant: code expired");
    expect(err.message).not.toContain("super-secret-value");
  });

  it("rejects a response without organisation_id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "T" }), { status: 200 }));
    await expect(exchangeAuthorizationCode(config, "C", fetchImpl)).rejects.toBeInstanceOf(PartnerOAuthError);
  });
});
