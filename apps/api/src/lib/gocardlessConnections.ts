/**
 * Storage of a landlord's own GoCardless connection (hosted install).
 *
 * The access token is encrypted at rest with lib/encryption.ts, decrypted only
 * to build a GoCardless client, and never logged or returned by the API:
 * callers get GoCardlessConnectionStatus.
 */

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getDb, gocardlessConnections, leases, properties } from "@rentular/db";
import { encrypt, decrypt } from "./encryption";
import type { GoCardlessEnvironment } from "./gocardlessPartner";

type ConnectionRow = typeof gocardlessConnections.$inferSelect;

export interface GoCardlessConnectionStatus {
  connected: boolean;
  status: "active" | "revoked" | "error" | null;
  organisationId: string | null;
  creditorId: string | null;
  creditorName: string | null;
  environment: GoCardlessEnvironment | null;
  scheme: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

/** Only these fields of a connection row ever leave the API. */
export function toConnectionStatus(row: ConnectionRow | null): GoCardlessConnectionStatus {
  if (!row) {
    return {
      connected: false,
      status: null,
      organisationId: null,
      creditorId: null,
      creditorName: null,
      environment: null,
      scheme: null,
      connectedAt: null,
      lastError: null,
    };
  }
  return {
    connected: row.status === "active" && !!row.accessTokenEncrypted,
    status: row.status,
    organisationId: row.organisationId,
    creditorId: row.creditorId ?? null,
    creditorName: row.creditorName ?? null,
    environment: row.environment,
    scheme: row.scheme ?? null,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    lastError: row.lastError ?? null,
  };
}

export async function loadConnection(ownerId: string): Promise<ConnectionRow | null> {
  const rows = await getDb()
    .select()
    .from(gocardlessConnections)
    .where(eq(gocardlessConnections.ownerId, ownerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConnectionStatus(ownerId: string): Promise<GoCardlessConnectionStatus> {
  return toConnectionStatus(await loadConnection(ownerId));
}

export interface ActiveCredentials {
  accessToken: string;
  environment: GoCardlessEnvironment;
  organisationId: string;
  creditorId: string | null;
}

/** The decrypted token of an active connection, or null when not connected. */
export async function loadActiveCredentials(ownerId: string): Promise<ActiveCredentials | null> {
  const row = await loadConnection(ownerId);
  if (!row || row.status !== "active") return null;
  if (!row.accessTokenEncrypted || !row.accessTokenIv || !row.accessTokenAuthTag) return null;
  return {
    accessToken: decrypt(row.accessTokenEncrypted, row.accessTokenIv, row.accessTokenAuthTag),
    environment: row.environment,
    organisationId: row.organisationId,
    creditorId: row.creditorId ?? null,
  };
}

/** Store (or replace) the landlord's connection after a successful OAuth exchange. */
export async function saveConnection(
  ownerId: string,
  input: {
    accessToken: string;
    organisationId: string;
    environment: GoCardlessEnvironment;
    creditorId: string | null;
    creditorName: string | null;
    scheme: string | null;
  },
): Promise<void> {
  const enc = encrypt(input.accessToken);
  const db = getDb();
  const existing = await loadConnection(ownerId);
  const now = new Date();
  const values = {
    organisationId: input.organisationId,
    creditorId: input.creditorId,
    creditorName: input.creditorName,
    accessTokenEncrypted: enc.encrypted,
    accessTokenIv: enc.iv,
    accessTokenAuthTag: enc.tag,
    environment: input.environment,
    scheme: input.scheme,
    status: "active" as const,
    connectedAt: now,
    lastError: null,
    updatedAt: now,
  };
  if (existing) {
    await db.update(gocardlessConnections).set(values).where(eq(gocardlessConnections.id, existing.id));
  } else {
    await db.insert(gocardlessConnections).values({ id: randomUUID(), ownerId, ...values });
  }
}

/**
 * Mark the connection revoked and wipe the token. The organisation id stays so
 * late webhooks for it are still recognised (and then ignored).
 */
export async function revokeConnection(ownerId: string, reason: string | null = null): Promise<void> {
  await getDb()
    .update(gocardlessConnections)
    .set({
      status: "revoked",
      accessTokenEncrypted: null,
      accessTokenIv: null,
      accessTokenAuthTag: null,
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(gocardlessConnections.ownerId, ownerId));
}

export async function recordConnectionError(ownerId: string, message: string): Promise<void> {
  await getDb()
    .update(gocardlessConnections)
    .set({ lastError: message.slice(0, 1000), updatedAt: new Date() })
    .where(eq(gocardlessConnections.ownerId, ownerId));
}

/** The landlord whose connection carries this GoCardless organisation id. */
export async function findOwnerByOrganisation(
  organisationId: string,
): Promise<{ ownerId: string; status: ConnectionRow["status"] } | null> {
  const rows = await getDb()
    .select({ ownerId: gocardlessConnections.ownerId, status: gocardlessConnections.status })
    .from(gocardlessConnections)
    .where(eq(gocardlessConnections.organisationId, organisationId))
    .limit(1);
  return rows[0] ?? null;
}

/** The owner of a property: the landlord whose GoCardless account collects for it. */
export async function ownerOfProperty(propertyId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ ownerId: properties.ownerId })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}

/** The owner of the property a lease belongs to. */
export async function ownerOfLease(leaseId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ ownerId: properties.ownerId })
    .from(leases)
    .innerJoin(properties, eq(leases.propertyId, properties.id))
    .where(eq(leases.id, leaseId))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}
