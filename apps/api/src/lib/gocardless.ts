import { createHash } from "crypto";
import { GOCARDLESS_SCHEME } from "@rentular/shared";
import { resolveInstance } from "./bankProviderOptions";
import { loadActiveCredentials, revokeConnection } from "./gocardlessConnections";
import { isPartnerConfigured, type GoCardlessEnvironment } from "./gocardlessPartner";

/**
 * GoCardless access, always on behalf of one landlord.
 *
 * Which token is used depends on the install:
 *   - self-hosted (one landlord, one creditor): the instance token from
 *     GOCARDLESS_ACCESS_TOKEN, as before.
 *   - hosted (many landlords): the landlord's own token from their GoCardless
 *     connection (partner OAuth). The instance token is never read there, so
 *     one landlord's tenants can never pay into another creditor. A landlord
 *     without a connection gets GOCARDLESS_NOT_CONNECTED.
 *
 * Every operation takes a GoCardlessScope naming the landlord: the owner of
 * the property the lease belongs to.
 */

export interface GoCardlessScope {
  ownerId: string;
}

export type GoCardlessUnavailableCode =
  | "GOCARDLESS_NOT_CONNECTED"
  | "GOCARDLESS_NOT_CONFIGURED"
  | "GOCARDLESS_PARTNER_NOT_CONFIGURED";

export class GoCardlessUnavailableError extends Error {
  constructor(
    readonly code: GoCardlessUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "GoCardlessUnavailableError";
  }
}

export function isGoCardlessUnavailable(err: unknown): err is GoCardlessUnavailableError {
  return err instanceof GoCardlessUnavailableError;
}

export type GoCardlessClient = {
  customers: {
    create: (params: Record<string, unknown>) => Promise<{ id?: string }>;
  };
  billingRequests: {
    create: (params: Record<string, unknown>) => Promise<{
      id?: string;
      links?: { customer?: string };
    }>;
  };
  billingRequestFlows: {
    create: (params: Record<string, unknown>) => Promise<{
      id?: string;
      authorisation_url?: string;
    }>;
  };
  mandates: {
    get: (id: string) => Promise<Record<string, any>>;
    cancel: (id: string) => Promise<Record<string, any>>;
  };
  payments: {
    create: (
      params: Record<string, unknown>,
      headers?: Record<string, string>
    ) => Promise<{ id?: string; status?: string; charge_date?: string }>;
    retry: (id: string) => Promise<Record<string, any>>;
    cancel: (id: string) => Promise<Record<string, any>>;
    list: (params: Record<string, unknown>) => Promise<Record<string, any>>;
  };
  creditors: {
    list: (params: Record<string, unknown>) => Promise<{
      creditors: Array<{
        id?: string;
        name?: string;
        scheme_identifiers?: Array<{ scheme: string }>;
      }>;
    }>;
  };
};

export type GoCardlessClientFactory = (
  accessToken: string,
  environment: GoCardlessEnvironment,
) => GoCardlessClient;

function sdkClientFactory(accessToken: string, environment: GoCardlessEnvironment): GoCardlessClient {
  const GoCardless = require("gocardless-nodejs");
  const { Environments } = require("gocardless-nodejs/constants");
  return new GoCardless(
    accessToken,
    environment === "live" ? Environments.Live : Environments.Sandbox,
  ) as GoCardlessClient;
}

let clientFactory: GoCardlessClientFactory = sdkClientFactory;
const clientCache = new Map<string, GoCardlessClient>();

/** Replace how clients are built (tests). Clears the cache. */
export function setGoCardlessClientFactory(factory: GoCardlessClientFactory | null): void {
  clientFactory = factory ?? sdkClientFactory;
  clientCache.clear();
}

/** Build (or reuse) a client for one token. Also used right after the OAuth exchange. */
export function clientForToken(accessToken: string, environment: GoCardlessEnvironment): GoCardlessClient {
  const key = `${environment}:${createHash("sha256").update(accessToken).digest("hex")}`;
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = clientFactory(accessToken, environment);
  clientCache.set(key, client);
  return client;
}

export function isHostedInstance(): boolean {
  return resolveInstance() === "hosted";
}

/** Self-hosted only: is the instance token set? Never meaningful on hosted. */
export function isInstanceTokenConfigured(): boolean {
  if (isHostedInstance()) return false;
  return !!process.env.GOCARDLESS_ACCESS_TOKEN;
}

export function instanceEnvironment(): GoCardlessEnvironment {
  return process.env.GOCARDLESS_ENVIRONMENT === "live" ? "live" : "sandbox";
}

/**
 * GoCardless answers 401 with reason access_token_revoked once the landlord
 * removed Rentular from their account (or a newer token replaced this one).
 */
export function isAccessTokenRevoked(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errors?: Array<{ reason?: unknown }>; message?: unknown };
  const reasons = Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : [];
  if (reasons.includes("access_token_revoked")) return true;
  return e.code === 401 && typeof e.message === "string" && e.message.includes("access_token_revoked");
}

/**
 * Wrap a landlord's client so a revoked token marks their connection revoked
 * and surfaces as GOCARDLESS_NOT_CONNECTED, which the UI turns into a
 * "connect GoCardless again" prompt.
 */
function guardRevokedToken(client: GoCardlessClient, ownerId: string): GoCardlessClient {
  const wrapResource = (resource: Record<string, unknown>) =>
    new Proxy(resource, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (err) {
            if (!isAccessTokenRevoked(err)) throw err;
            console.warn(`[GoCardless] Token of landlord ${ownerId} was revoked at GoCardless; marking the connection revoked`);
            await revokeConnection(ownerId, "Access was revoked at GoCardless. Connect again.").catch((e) =>
              console.error("[GoCardless] could not mark the connection revoked:", (e as Error).message)
            );
            throw new GoCardlessUnavailableError(
              "GOCARDLESS_NOT_CONNECTED",
              "Your GoCardless access was revoked. Connect GoCardless again in Settings."
            );
          }
        };
      },
    });
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      return value && typeof value === "object" ? wrapResource(value as Record<string, unknown>) : value;
    },
  });
}

export interface ResolvedClient {
  client: GoCardlessClient;
  source: "account" | "instance";
  environment: GoCardlessEnvironment;
  /** Hosted: the creditor stored on the landlord's connection. */
  creditorId: string | null;
}

/**
 * The GoCardless client for one landlord. Hosted: their own connection, or
 * GOCARDLESS_NOT_CONNECTED. Self-hosted: the instance token.
 */
export async function getGoCardlessClientFor(scope: GoCardlessScope): Promise<ResolvedClient> {
  if (isHostedInstance()) {
    if (!isPartnerConfigured()) {
      throw new GoCardlessUnavailableError(
        "GOCARDLESS_PARTNER_NOT_CONFIGURED",
        "Direct debit is not available on this installation yet.",
      );
    }
    const creds = await loadActiveCredentials(scope.ownerId);
    if (!creds) {
      throw new GoCardlessUnavailableError(
        "GOCARDLESS_NOT_CONNECTED",
        "Connect your own GoCardless account in Settings first.",
      );
    }
    return {
      client: guardRevokedToken(clientForToken(creds.accessToken, creds.environment), scope.ownerId),
      source: "account",
      environment: creds.environment,
      creditorId: creds.creditorId,
    };
  }

  const accessToken = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!accessToken) {
    throw new GoCardlessUnavailableError(
      "GOCARDLESS_NOT_CONFIGURED",
      "GoCardless is not configured. Set GOCARDLESS_ACCESS_TOKEN.",
    );
  }
  const environment = instanceEnvironment();
  return {
    client: clientForToken(accessToken, environment),
    source: "instance",
    environment,
    creditorId: null,
  };
}

export interface GoCardlessAvailability {
  available: boolean;
  code: GoCardlessUnavailableCode | null;
  mode: "partner" | "instance";
}

/** Can GoCardless be used for this landlord right now? Never throws. */
export async function getGoCardlessAvailability(scope: GoCardlessScope): Promise<GoCardlessAvailability> {
  const mode = isHostedInstance() ? "partner" : "instance";
  try {
    await getGoCardlessClientFor(scope);
    return { available: true, code: null, mode };
  } catch (err) {
    if (isGoCardlessUnavailable(err)) return { available: false, code: err.code, mode };
    console.error("[GoCardless] availability check failed:", (err as Error).message);
    return { available: false, code: "GOCARDLESS_NOT_CONNECTED", mode };
  }
}

// Verify webhook signature from GoCardless
// GoCardless signs webhooks with HMAC-SHA256
export function verifyWebhookSignature(
  body: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const crypto = require("crypto");
  const computed = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computed)
    );
  } catch {
    return false;
  }
}

// GoCardless event types we handle
export interface GoCardlessEvent {
  id: string;
  created_at: string;
  resource_type: string;
  action: string;
  links: Record<string, string>;
  details: {
    origin: string;
    cause: string;
    description: string;
  };
}

export interface GoCardlessWebhookPayload {
  events: GoCardlessEvent[];
}

type CreditorRecord = {
  id?: string;
  name?: string;
  scheme_identifiers?: Array<{ scheme: string }>;
};

/**
 * Pick the creditor to collect into. A preferred id (the connection's stored
 * creditor, or GOCARDLESS_CREDITOR_ID on a self-hosted install) wins when it
 * is in the list; otherwise the first one.
 */
export function selectCreditor(
  creditors: CreditorRecord[],
  preferredId: string | null | undefined,
): { creditor: CreditorRecord | null; matchedPreferred: boolean } {
  if (preferredId) {
    const match = creditors.find((cr) => cr.id === preferredId);
    if (match) return { creditor: match, matchedPreferred: true };
  }
  return { creditor: creditors[0] ?? null, matchedPreferred: false };
}

export interface CreditorInfo {
  creditorId: string;
  name: string | null;
  scheme: string;
}

export function toCreditorInfo(creditor: CreditorRecord): CreditorInfo {
  return {
    creditorId: creditor.id || "",
    name: creditor.name || null,
    scheme: creditor.scheme_identifiers?.[0]?.scheme || "sepa_core",
  };
}

// Get creditor information for the landlord's GoCardless client
export async function getCreditorInfo(scope: GoCardlessScope): Promise<CreditorInfo | null> {
  const resolved = await getGoCardlessClientFor(scope);
  const result = await resolved.client.creditors.list({});
  const creditors = result.creditors ?? [];
  const preferred =
    resolved.source === "account"
      ? resolved.creditorId
      : process.env.GOCARDLESS_CREDITOR_ID?.trim() || null;
  const { creditor, matchedPreferred } = selectCreditor(creditors, preferred);
  if (!creditor) return null;
  if (resolved.source === "instance" && creditors.length > 1 && !matchedPreferred) {
    console.log(
      `[GoCardless] The instance token has ${creditors.length} creditors; using the first (${creditor.id}). Set GOCARDLESS_CREDITOR_ID to choose another.`
    );
  }
  return toCreditorInfo(creditor);
}

async function clientFor(scope: GoCardlessScope): Promise<GoCardlessClient> {
  return (await getGoCardlessClientFor(scope)).client;
}

// Create a customer in GoCardless from tenant data
export async function createCustomer(
  scope: GoCardlessScope,
  params: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
    addressLine1?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  }
): Promise<string> {
  const gc = await clientFor(scope);

  const customer = await gc.customers.create({
    email: params.email,
    given_name: params.firstName,
    family_name: params.lastName,
    phone_number: params.phone || undefined,
    address_line1: params.addressLine1 || undefined,
    city: params.city || undefined,
    postal_code: params.postalCode || undefined,
    country_code: params.countryCode || "BE",
  });

  return customer.id!;
}

// Create a billing request flow for mandate setup
// Returns a URL the tenant visits to authorise the SEPA direct debit mandate
export async function createMandateSetupFlow(
  scope: GoCardlessScope,
  params: {
    tenantEmail: string;
    tenantFirstName: string;
    tenantLastName: string;
    customerId?: string;
    description: string;
    redirectUrl: string;
    metadata?: Record<string, string>;
  }
): Promise<{ flowId: string; authorisationUrl: string; customerId?: string }> {
  const gc = await clientFor(scope);

  // Step 1: Create a billing request
  const billingRequest = await gc.billingRequests.create({
    mandate_request: {
      scheme: GOCARDLESS_SCHEME,
      metadata: params.metadata,
    },
    ...(params.customerId
      ? {
          links: {
            customer: params.customerId,
          },
        }
      : {}),
  });

  // Step 2: Create a billing request flow (redirect URL for tenant)
  const flow = await gc.billingRequestFlows.create({
    redirect_uri: params.redirectUrl,
    exit_uri: params.redirectUrl,
    links: {
      billing_request: billingRequest.id!,
    },
    // Pre-fill tenant details if no existing customer
    ...(!params.customerId
      ? {
          prefilled_customer: {
            email: params.tenantEmail,
            given_name: params.tenantFirstName,
            family_name: params.tenantLastName,
          },
        }
      : {}),
  });

  return {
    flowId: flow.id!,
    authorisationUrl: flow.authorisation_url!,
    customerId: billingRequest.links?.customer,
  };
}

// Get mandate details
export async function getMandate(scope: GoCardlessScope, mandateId: string) {
  const gc = await clientFor(scope);
  return gc.mandates.get(mandateId);
}

// Cancel a mandate
export async function cancelMandate(scope: GoCardlessScope, mandateId: string) {
  const gc = await clientFor(scope);
  return gc.mandates.cancel(mandateId);
}

// Create a payment against an active mandate
export async function createPayment(
  scope: GoCardlessScope,
  params: {
    mandateId: string;
    amount: number; // in EUR (will be converted to cents)
    description: string;
    chargeDate?: string; // YYYY-MM-DD, defaults to earliest possible
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }
): Promise<{
  paymentId: string;
  status: string;
  chargeDate: string;
}> {
  const gc = await clientFor(scope);

  // GoCardless amounts are in cents
  const amountInCents = Math.round(params.amount * 100);

  const payment = await gc.payments.create(
    {
      amount: amountInCents,
      currency: "EUR",
      description: params.description,
      links: {
        mandate: params.mandateId,
      },
      charge_date: params.chargeDate || undefined,
      metadata: params.metadata,
      // app_fee: a partner app may take a fee in cents on payments created
      // with a landlord's token. Rentular charges none, so it is not sent.
    },
    params.idempotencyKey
      ? { "Idempotency-Key": params.idempotencyKey }
      : undefined
  );

  return {
    paymentId: payment.id!,
    status: payment.status!,
    chargeDate: payment.charge_date!,
  };
}

// Retry a failed payment
export async function retryPayment(scope: GoCardlessScope, paymentId: string) {
  const gc = await clientFor(scope);
  return gc.payments.retry(paymentId);
}

// Cancel a pending payment
export async function cancelPayment(scope: GoCardlessScope, paymentId: string) {
  const gc = await clientFor(scope);
  return gc.payments.cancel(paymentId);
}

// List payments for a mandate
export async function listPayments(scope: GoCardlessScope, mandateId: string) {
  const gc = await clientFor(scope);
  return gc.payments.list({ mandate: mandateId });
}

export { GOCARDLESS_SCHEME };
