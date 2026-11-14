/**
 * GoCardless partner app (OAuth), used on a hosted install so every landlord
 * connects their own GoCardless account and rent lands in their own creditor.
 *
 * Flow (GoCardless partner integration, "GoCardless Connect"):
 *   1. Send the landlord to the authorize url with client_id, redirect_uri,
 *      scope=read_write, a signed state and an initial_view.
 *   2. GoCardless redirects back to redirect_uri with ?code=...&state=...
 *   3. Exchange the code at the token endpoint (form encoded, with the client
 *      secret) for { access_token, organisation_id, email, scope }.
 *   4. The access token acts for that landlord's organisation only.
 *
 * Partner credentials come from GOCARDLESS_PARTNER_CLIENT_ID,
 * GOCARDLESS_PARTNER_CLIENT_SECRET and GOCARDLESS_PARTNER_ENVIRONMENT
 * (sandbox|live). Without them direct debit is unavailable on a hosted
 * install; there is no fallback to the instance token.
 */

export type GoCardlessEnvironment = "sandbox" | "live";

export interface PartnerConfig {
  clientId: string;
  clientSecret: string;
  environment: GoCardlessEnvironment;
  redirectUri: string;
}

const CONNECT_HOSTS: Record<GoCardlessEnvironment, string> = {
  sandbox: "https://connect-sandbox.gocardless.com",
  live: "https://connect.gocardless.com",
};

export function partnerEnvironment(env: NodeJS.ProcessEnv = process.env): GoCardlessEnvironment {
  return (env.GOCARDLESS_PARTNER_ENVIRONMENT || "").trim().toLowerCase() === "live"
    ? "live"
    : "sandbox";
}

/**
 * The callback url to register in the GoCardless partner app. Override with
 * GOCARDLESS_PARTNER_REDIRECT_URL; otherwise the public web url, since /api/v1
 * is served on the same host.
 */
export function getPartnerRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GOCARDLESS_PARTNER_REDIRECT_URL?.trim();
  if (override) return override;
  const web = (env.WEB_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${web}/api/v1/gocardless/connect/callback`;
}

export function getPartnerConfig(env: NodeJS.ProcessEnv = process.env): PartnerConfig | null {
  const clientId = env.GOCARDLESS_PARTNER_CLIENT_ID?.trim();
  const clientSecret = env.GOCARDLESS_PARTNER_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    environment: partnerEnvironment(env),
    redirectUri: getPartnerRedirectUri(env),
  };
}

export function isPartnerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getPartnerConfig(env) !== null;
}

export function buildAuthorizeUrl(
  config: PartnerConfig,
  params: { state: string; initialView?: "login" | "signup"; email?: string | null; language?: string },
): string {
  const url = new URL("/oauth/authorize", CONNECT_HOSTS[config.environment]);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("initial_view", params.initialView || "login");
  if (params.email) url.searchParams.set("prefill[email]", params.email);
  if (params.language) url.searchParams.set("language", params.language);
  return url.toString();
}

export interface PartnerTokenResult {
  accessToken: string;
  organisationId: string;
  email: string | null;
  scope: string | null;
}

export class PartnerOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PartnerOAuthError";
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Exchange the authorization code for the landlord's access token. */
export async function exchangeAuthorizationCode(
  config: PartnerConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<PartnerTokenResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetchImpl(`${CONNECT_HOSTS[config.environment]}/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (!res.ok) {
    // Only the error code and description, never the request body (it holds
    // the client secret).
    const reason = [json.error, json.error_description].filter(Boolean).join(": ");
    throw new PartnerOAuthError(reason || `Token exchange failed (${res.status})`, res.status);
  }
  const accessToken = typeof json.access_token === "string" ? json.access_token : "";
  const organisationId = typeof json.organisation_id === "string" ? json.organisation_id : "";
  if (!accessToken || !organisationId) {
    throw new PartnerOAuthError("Token response is missing access_token or organisation_id", res.status);
  }
  return {
    accessToken,
    organisationId,
    email: typeof json.email === "string" ? json.email : null,
    scope: typeof json.scope === "string" ? json.scope : null,
  };
}
