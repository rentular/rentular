/**
 * GoCardless routes, mounted at /api/v1/gocardless.
 *
 * Every GoCardless call acts for the owner of the property involved, with
 * that owner's own GoCardless account on a hosted install (see lib/gocardless.ts).
 *
 *   GET  /status               this user's GoCardless setup (or, with ?leaseId=,
 *                              whether the lease's landlord can collect). Never a token.
 *   GET  /creditor             the creditor of this user's account
 *   GET  /connect              hosted: start the partner OAuth, returns { url }
 *   GET  /connect/callback     redirect target after GoCardless (state JWT, no session)
 *   POST /disconnect           revoke this user's GoCardless token and forget it
 *   GET  /mandates             mandates on the user's accessible properties
 *   POST /mandates/setup       start a tenant mandate (billing request flow)
 *   POST /mandates/complete    store the mandate after the tenant returns
 *   GET  /mandates/:mandateId  one mandate (only when the user has access to it)
 *   POST /mandates/:mandateId/cancel
 *   POST /customers            create a GoCardless customer for a tenant
 *
 * The callback is exempt from the session check in index.ts; the signed state
 * JWT, bound to the landlord and the "gocardless" flow, takes its place.
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { getDb, tenants, leases, properties, users } from "@rentular/db";
import {
  createMandateSetupFlow,
  getMandate,
  cancelMandate,
  createCustomer,
  getCreditorInfo,
  getGoCardlessAvailability,
  isGoCardlessUnavailable,
  isHostedInstance,
  isInstanceTokenConfigured,
  instanceEnvironment,
  clientForToken,
  selectCreditor,
  toCreditorInfo,
} from "../lib/gocardless";
import {
  getConnectionStatus,
  loadActiveCredentials,
  ownerOfProperty,
  revokeConnection,
  saveConnection,
} from "../lib/gocardlessConnections";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getPartnerConfig,
  getPartnerRedirectUri,
  revokeAccessToken,
} from "../lib/gocardlessPartner";
import { signOAuthState, verifyOAuthState } from "../lib/bankOAuthState";
import { getRequiredUserId } from "../lib/routeAuth";
import {
  getUserPropertyRole,
  hasMinimumRole,
  getAccessiblePropertyIds,
  getAccessiblePropertyIdsForRole,
} from "../lib/propertyAccess";
import type { PropertyManagerRole } from "@rentular/shared";
import { todayInZone } from "../lib/timezone";

export const gocardlessRouter = new Hono();

function webUrl(): string {
  return (process.env.WEB_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** Where the landlord lands after the connect flow. */
function settingsUrl(query: Record<string, string>): string {
  const qs = new URLSearchParams({ tab: "gocardless", ...query }).toString();
  return `${webUrl()}/settings?${qs}`;
}

function unavailableResponse(c: Context, err: unknown) {
  if (isGoCardlessUnavailable(err)) {
    return c.json({ error: err.message, code: err.code }, 409);
  }
  return null;
}

/**
 * Connecting a GoCardless account is for landlords: owners or co-owners, or
 * a new account without any property yet. A user who only manages other
 * landlords' properties has no use for one (it would never be used).
 */
async function canManageOwnConnection(userId: string): Promise<boolean> {
  const asOwner = await getAccessiblePropertyIdsForRole(userId, "co_owner");
  if (asOwner.length > 0) return true;
  const any = await getAccessiblePropertyIds(userId);
  return any.length === 0;
}

/** The lease, the user's role on it and the landlord who collects for it. */
async function leaseAccess(
  userId: string,
  leaseId: string,
): Promise<{ lease: typeof leases.$inferSelect; role: PropertyManagerRole; ownerId: string } | null> {
  const db = getDb();
  const rows = await db.select().from(leases).where(eq(leases.id, leaseId)).limit(1);
  const lease = rows[0];
  if (!lease) return null;
  const role = await getUserPropertyRole(userId, lease.propertyId);
  if (!role) return null;
  const ownerId = await ownerOfProperty(lease.propertyId);
  if (!ownerId) return null;
  return { lease, role, ownerId };
}

/**
 * Resolve a mandate id to the landlord it belongs to, only when this user
 * has at least `minRole` on a lease using it, or owns the tenant holding it.
 */
async function mandateAccess(
  userId: string,
  mandateId: string,
  minRole: PropertyManagerRole,
): Promise<{ ownerId: string } | null> {
  const db = getDb();
  const leaseRows = await db
    .select({ propertyId: leases.propertyId, ownerId: properties.ownerId })
    .from(leases)
    .innerJoin(properties, eq(leases.propertyId, properties.id))
    .where(eq(leases.gocardlessMandateId, mandateId));
  for (const row of leaseRows) {
    const role = await getUserPropertyRole(userId, row.propertyId);
    if (role && hasMinimumRole(role, minRole)) return { ownerId: row.ownerId };
  }
  if (leaseRows.length === 0) {
    const tenantRows = await db
      .select({ ownerId: tenants.ownerId })
      .from(tenants)
      .where(eq(tenants.gocardlessMandateId, mandateId))
      .limit(1);
    if (tenantRows[0] && tenantRows[0].ownerId === userId) return { ownerId: userId };
  }
  return null;
}

// ===========================================================================
// Setup: status, creditor, connect, disconnect
// ===========================================================================

gocardlessRouter.get("/status", async (c) => {
  const userId = getRequiredUserId(c);
  const hosted = isHostedInstance();

  // For the mandate setup dialog: can the landlord of this lease collect?
  const leaseId = c.req.query("leaseId");
  if (leaseId) {
    const access = await leaseAccess(userId, leaseId);
    if (!access || !hasMinimumRole(access.role, "manager")) {
      return c.json({ error: "Lease not found" }, 404);
    }
    const availability = await getGoCardlessAvailability({ ownerId: access.ownerId });
    return c.json({
      data: {
        mode: availability.mode,
        available: availability.available,
        code: availability.code,
        isOwnAccount: access.ownerId === userId,
      },
    });
  }

  if (hosted) {
    const partner = getPartnerConfig();
    const connection = await getConnectionStatus(userId);
    return c.json({
      data: {
        mode: "partner",
        partnerConfigured: !!partner,
        canConnect: !!partner && (await canManageOwnConnection(userId)),
        configured: !!partner && connection.connected,
        environment: connection.environment ?? partner?.environment ?? null,
        connection,
      },
    });
  }

  return c.json({
    data: {
      mode: "instance",
      partnerConfigured: false,
      canConnect: false,
      configured: isInstanceTokenConfigured(),
      environment: instanceEnvironment(),
      connection: null,
    },
  });
});

gocardlessRouter.get("/creditor", async (c) => {
  const userId = getRequiredUserId(c);
  try {
    const info = await getCreditorInfo({ ownerId: userId });
    if (!info) {
      return c.json({ error: "No creditor found." }, 404);
    }
    return c.json({ data: info });
  } catch (err: unknown) {
    const unavailable = unavailableResponse(c, err);
    if (unavailable) return unavailable;
    console.error("[GoCardless] creditor lookup failed:", (err as Error).message);
    return c.json({ error: "Failed to fetch creditor" }, 500);
  }
});

gocardlessRouter.get("/connect", async (c) => {
  const userId = getRequiredUserId(c);
  if (!isHostedInstance()) {
    return c.json(
      { error: "This installation uses its own GoCardless token (GOCARDLESS_ACCESS_TOKEN).", code: "NOT_HOSTED" },
      400
    );
  }
  const partner = getPartnerConfig();
  if (!partner) {
    return c.json(
      { error: "Direct debit is not available on this installation yet.", code: "GOCARDLESS_PARTNER_NOT_CONFIGURED" },
      503
    );
  }
  if (!(await canManageOwnConnection(userId))) {
    return c.json({ error: "Only a landlord can connect a GoCardless account." }, 403);
  }

  const userRows = await getDb()
    .select({ email: users.email, language: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const initialView = c.req.query("view") === "signup" ? "signup" : "login";
  const state = await signOAuthState({ ownerId: userId, provider: "gocardless" });
  const url = buildAuthorizeUrl(partner, {
    state,
    initialView,
    email: userRows[0]?.email ?? null,
    language: userRows[0]?.language ?? undefined,
  });
  return c.json({ data: { url, redirectUri: getPartnerRedirectUri() } });
});

gocardlessRouter.get("/connect/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const oauthError = c.req.query("error");

  if (!state) return c.redirect(settingsUrl({ gocardless: "error", reason: "missing_state" }));

  let ownerId: string;
  try {
    const payload = await verifyOAuthState(state);
    if (payload.provider !== "gocardless") throw new Error("state is not for the GoCardless flow");
    ownerId = payload.ownerId;
  } catch (err) {
    console.warn("[GoCardless] connect callback: state rejected:", (err as Error).message);
    return c.redirect(settingsUrl({ gocardless: "error", reason: "expired_state" }));
  }

  if (oauthError) {
    // The landlord cancelled at GoCardless (access_denied) or GoCardless refused.
    return c.redirect(settingsUrl({ gocardless: "error", reason: oauthError === "access_denied" ? "cancelled" : "denied" }));
  }
  if (!code) return c.redirect(settingsUrl({ gocardless: "error", reason: "missing_code" }));

  const partner = isHostedInstance() ? getPartnerConfig() : null;
  if (!partner) return c.redirect(settingsUrl({ gocardless: "error", reason: "not_available" }));

  try {
    const token = await exchangeAuthorizationCode(partner, code);
    // The creditor of the landlord's own organisation, read with their token.
    const client = clientForToken(token.accessToken, partner.environment);
    const list = await client.creditors.list({});
    const { creditor } = selectCreditor(list.creditors ?? [], null);
    const info = creditor ? toCreditorInfo(creditor) : null;
    await saveConnection(ownerId, {
      accessToken: token.accessToken,
      organisationId: token.organisationId,
      environment: partner.environment,
      creditorId: info?.creditorId || null,
      creditorName: info?.name || null,
      scheme: info?.scheme || null,
    });
    console.log(
      `[GoCardless] Landlord ${ownerId} connected organisation ${token.organisationId} (${partner.environment})`
    );
    return c.redirect(settingsUrl({ gocardless: "connected" }));
  } catch (err) {
    console.error("[GoCardless] connect callback failed:", (err as Error).message);
    return c.redirect(settingsUrl({ gocardless: "error", reason: "exchange_failed" }));
  }
});

gocardlessRouter.post("/disconnect", async (c) => {
  const userId = getRequiredUserId(c);
  if (!isHostedInstance()) {
    return c.json({ error: "This installation uses its own GoCardless token.", code: "NOT_HOSTED" }, 400);
  }
  // Revoke the token at GoCardless (best effort), then wipe it here anyway.
  let revokedAtGoCardless = false;
  const partner = getPartnerConfig();
  if (partner) {
    try {
      const creds = await loadActiveCredentials(userId);
      if (creds) revokedAtGoCardless = await revokeAccessToken(partner, creds.accessToken);
    } catch (err) {
      console.error("[GoCardless] revoke at GoCardless failed:", (err as Error).message);
    }
  }
  await revokeConnection(userId, null);
  console.log(
    `[GoCardless] Landlord ${userId} disconnected their GoCardless account (revoked at GoCardless: ${revokedAtGoCardless})`
  );
  return c.json({ data: await getConnectionStatus(userId) });
});

// ===========================================================================
// Mandates
// ===========================================================================

// List all mandates for the current user's accessible properties
gocardlessRouter.get("/mandates", async (c) => {
  const userId = getRequiredUserId(c);
  const db = getDb();
  const status = c.req.query("status");
  const search = c.req.query("search");

  // Get all accessible property IDs for this user
  const propertyIds = await getAccessiblePropertyIds(userId);
  if (!propertyIds.length) {
    return c.json({ data: [] });
  }

  // Query leases with mandates, with the landlord who collects for each
  const leaseRows = await db
    .select({
      leaseId: leases.id,
      mandateId: leases.gocardlessMandateId,
      propertyId: leases.propertyId,
      startDate: leases.startDate,
      endDate: leases.endDate,
      ownerId: properties.ownerId,
    })
    .from(leases)
    .innerJoin(properties, eq(leases.propertyId, properties.id))
    .where(
      and(
        isNotNull(leases.gocardlessMandateId),
        sql`${leases.propertyId} IN (${sql.join(
          propertyIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
    );

  // Enrich with tenant and property data, and GoCardless mandate status
  const mandates = [];
  for (const row of leaseRows) {
    // Get tenant for this lease
    const tenantResult = await db
      .select({
        id: tenants.id,
        firstName: tenants.firstName,
        lastName: tenants.lastName,
        email: tenants.email,
      })
      .from(tenants)
      .where(eq(tenants.gocardlessMandateId, row.mandateId!));

    // Get property
    const propResult = await db
      .select({
        id: properties.id,
        street: properties.street,
        streetNumber: properties.streetNumber,
        city: properties.city,
      })
      .from(properties)
      .where(eq(properties.id, row.propertyId));

    // Mandate status from the landlord's own GoCardless account (with fallback)
    let mandateStatus = "unknown";
    let createdAt = "";
    let nextChargeDate = "";
    if (row.mandateId) {
      try {
        const m = await getMandate({ ownerId: row.ownerId }, row.mandateId);
        mandateStatus = m.status || "unknown";
        createdAt = m.created_at || "";
        nextChargeDate = m.next_possible_charge_date || "";
      } catch {
        mandateStatus = "unknown";
      }
    }

    // Apply status filter
    if (status && status !== "all" && mandateStatus !== status) continue;

    const tenant = tenantResult[0];
    const prop = propResult[0];
    const tenantName = tenant
      ? `${tenant.firstName} ${tenant.lastName}`
      : "Unknown";
    const propertyAddress = prop
      ? `${prop.street} ${prop.streetNumber}, ${prop.city}`
      : "Unknown";

    // Apply search filter
    if (search) {
      const q = search.toLowerCase();
      if (
        !tenantName.toLowerCase().includes(q) &&
        !propertyAddress.toLowerCase().includes(q)
      )
        continue;
    }

    mandates.push({
      mandateId: row.mandateId,
      leaseId: row.leaseId,
      tenantId: tenant?.id || null,
      tenantName,
      tenantEmail: tenant?.email || "",
      propertyId: row.propertyId,
      propertyAddress,
      leaseRef: `${row.startDate} - ${row.endDate || "ongoing"}`,
      status: mandateStatus,
      createdAt,
      nextChargeDate,
    });
  }

  return c.json({ data: mandates });
});

// Start mandate setup flow for a tenant
// Returns a redirect URL the tenant visits to authorise the SEPA direct debit
gocardlessRouter.post(
  "/mandates/setup",
  zValidator(
    "json",
    z.object({
      tenantId: z.string().uuid(),
      leaseId: z.string().uuid(),
      // Tenant details (passed from frontend, which has the tenant record)
      tenantEmail: z.string().email(),
      tenantFirstName: z.string().min(1),
      tenantLastName: z.string().min(1),
      // Optional: if tenant already has a GoCardless customer ID
      gocardlessCustomerId: z.string().optional(),
      // URL to redirect tenant after mandate authorisation
      redirectUrl: z.string().url(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const userId = getRequiredUserId(c);

    // Verify lease exists and user has manager+ role on its property
    const access = await leaseAccess(userId, data.leaseId);
    if (!access) {
      return c.json({ error: "Lease not found" }, 404);
    }
    if (!hasMinimumRole(access.role, "manager")) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    try {
      const result = await createMandateSetupFlow({ ownerId: access.ownerId }, {
        tenantEmail: data.tenantEmail,
        tenantFirstName: data.tenantFirstName,
        tenantLastName: data.tenantLastName,
        customerId: data.gocardlessCustomerId,
        description: `Rent payment mandate for lease ${data.leaseId}`,
        redirectUrl: data.redirectUrl,
        metadata: {
          tenant_id: data.tenantId,
          lease_id: data.leaseId,
        },
      });

      return c.json({
        data: {
          flowId: result.flowId,
          authorisationUrl: result.authorisationUrl,
          customerId: result.customerId,
        },
        message:
          "Mandate setup flow created. Redirect the tenant to authorisationUrl.",
      });
    } catch (err: unknown) {
      const unavailable = unavailableResponse(c, err);
      if (unavailable) return unavailable;
      const message =
        err instanceof Error ? err.message : "Failed to create mandate flow";
      console.error("[GoCardless] Mandate setup error:", err);
      return c.json({ error: message }, 500);
    }
  }
);

// Complete mandate setup - called after tenant returns from GoCardless redirect
// The billing request flow will have created a mandate; we need to look it up
gocardlessRouter.post(
  "/mandates/complete",
  zValidator(
    "json",
    z.object({
      tenantId: z.string().uuid(),
      leaseId: z.string().uuid(),
      billingRequestId: z.string().optional(),
      // GoCardless returns the mandate ID as a query param on redirect
      mandateId: z.string().optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");

    if (!data.mandateId) {
      return c.json(
        { error: "mandateId is required after redirect completion." },
        400
      );
    }

    const userId = getRequiredUserId(c);
    const db = getDb();

    // Verify lease exists and user has manager+ role on its property, before
    // anything is read from GoCardless.
    const access = await leaseAccess(userId, data.leaseId);
    if (!access) {
      return c.json({ error: "Lease not found" }, 404);
    }
    if (!hasMinimumRole(access.role, "manager")) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    try {
      // The mandate must exist in THIS landlord's GoCardless account.
      const mandate = await getMandate({ ownerId: access.ownerId }, data.mandateId);

      if (!mandate || !["pending_submission", "submitted", "active"].includes(mandate.status!)) {
        return c.json(
          {
            error: `Mandate is not in a valid state: ${mandate?.status}`,
          },
          400
        );
      }

      // Update lease with mandate ID
      await db
        .update(leases)
        .set({
          gocardlessMandateId: mandate.id,
          paymentMethod: "gocardless",
          updatedAt: new Date(),
        })
        .where(eq(leases.id, data.leaseId));

      // Update tenant with mandate ID and customer ID (the landlord's tenant only)
      await db
        .update(tenants)
        .set({
          gocardlessMandateId: mandate.id,
          gocardlessCustomerId: mandate.links?.customer || null,
          updatedAt: new Date(),
        })
        .where(and(eq(tenants.id, data.tenantId), eq(tenants.ownerId, access.ownerId)));

      console.log(
        `[GoCardless] Mandate ${mandate.id} linked to lease ${data.leaseId} and tenant ${data.tenantId}`
      );

      return c.json({
        data: {
          mandateId: mandate.id,
          mandateStatus: mandate.status,
          customerId: mandate.links?.customer,
          scheme: mandate.scheme,
          bankAccount: mandate.links?.customer_bank_account,
        },
        message: "Mandate setup completed. Direct debit is now active.",
      });
    } catch (err: unknown) {
      const unavailable = unavailableResponse(c, err);
      if (unavailable) return unavailable;
      const message =
        err instanceof Error ? err.message : "Failed to complete mandate setup";
      console.error("[GoCardless] Mandate complete error:", err);
      return c.json({ error: message }, 500);
    }
  }
);

// Get mandate status
gocardlessRouter.get("/mandates/:mandateId", async (c) => {
  const userId = getRequiredUserId(c);
  const mandateId = c.req.param("mandateId");

  const access = await mandateAccess(userId, mandateId, "viewer");
  if (!access) {
    return c.json({ error: "Mandate not found" }, 404);
  }

  try {
    const mandate = await getMandate({ ownerId: access.ownerId }, mandateId);
    return c.json({
      data: {
        id: mandate.id,
        status: mandate.status,
        scheme: mandate.scheme,
        reference: mandate.reference,
        nextPossibleChargeDate: mandate.next_possible_charge_date,
        createdAt: mandate.created_at,
      },
    });
  } catch (err: unknown) {
    const unavailable = unavailableResponse(c, err);
    if (unavailable) return unavailable;
    const message =
      err instanceof Error ? err.message : "Failed to fetch mandate";
    return c.json({ error: message }, 500);
  }
});

// Cancel a mandate
gocardlessRouter.post("/mandates/:mandateId/cancel", async (c) => {
  const userId = getRequiredUserId(c);
  const mandateId = c.req.param("mandateId");

  const access = await mandateAccess(userId, mandateId, "manager");
  if (!access) {
    return c.json({ error: "Mandate not found" }, 404);
  }

  try {
    const mandate = await cancelMandate({ ownerId: access.ownerId }, mandateId);

    const db = getDb();

    // Flag affected leases with a visible note before clearing mandate (D-13)
    const affectedLeases = await db
      .select({ id: leases.id, notes: leases.notes })
      .from(leases)
      .innerJoin(properties, eq(leases.propertyId, properties.id))
      .where(and(eq(leases.gocardlessMandateId, mandateId), eq(properties.ownerId, access.ownerId)));

    for (const lease of affectedLeases) {
      const flagNote = `Mandate ${mandateId} cancelled on ${todayInZone()} -- SEPA collection stopped, action required.`;
      const updatedNotes = lease.notes
        ? `${lease.notes}\n${flagNote}`
        : flagNote;
      await db
        .update(leases)
        .set({
          notes: updatedNotes,
          gocardlessMandateId: null,
          updatedAt: new Date(),
        })
        .where(eq(leases.id, lease.id));
    }

    // Clear mandate from this landlord's tenants
    await db
      .update(tenants)
      .set({
        gocardlessMandateId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tenants.gocardlessMandateId, mandateId), eq(tenants.ownerId, access.ownerId)));

    console.log(
      `[GoCardless] Mandate ${mandateId} cancelled: flagged ${affectedLeases.length} lease(s), cleared from DB`
    );

    return c.json({
      data: {
        id: mandate.id,
        status: mandate.status,
      },
      message: "Mandate cancelled. Automatic collection is disabled.",
    });
  } catch (err: unknown) {
    const unavailable = unavailableResponse(c, err);
    if (unavailable) return unavailable;
    const message =
      err instanceof Error ? err.message : "Failed to cancel mandate";
    return c.json({ error: message }, 500);
  }
});

// Create a GoCardless customer from tenant details
gocardlessRouter.post(
  "/customers",
  zValidator(
    "json",
    z.object({
      tenantId: z.string().uuid(),
      email: z.string().email(),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      phone: z.string().optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const userId = getRequiredUserId(c);
    const db = getDb();

    // The customer is created in the tenant's landlord's account; only that
    // landlord may do so.
    const tenantRows = await db
      .select({ ownerId: tenants.ownerId })
      .from(tenants)
      .where(eq(tenants.id, data.tenantId))
      .limit(1);
    if (!tenantRows[0] || tenantRows[0].ownerId !== userId) {
      return c.json({ error: "Tenant not found" }, 404);
    }
    const ownerId = tenantRows[0].ownerId;

    try {
      const customerId = await createCustomer({ ownerId }, {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        countryCode: "BE",
      });

      // Persist GoCardless customer ID to tenant record
      await db
        .update(tenants)
        .set({
          gocardlessCustomerId: customerId,
          updatedAt: new Date(),
        })
        .where(and(eq(tenants.id, data.tenantId), eq(tenants.ownerId, ownerId)));

      console.log(
        `[GoCardless] Customer ${customerId} linked to tenant ${data.tenantId}`
      );

      return c.json({
        data: { customerId },
        message: "GoCardless customer created.",
      });
    } catch (err: unknown) {
      const unavailable = unavailableResponse(c, err);
      if (unavailable) return unavailable;
      const message =
        err instanceof Error ? err.message : "Failed to create customer";
      return c.json({ error: message }, 500);
    }
  }
);
