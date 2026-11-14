/**
 * Processing of GoCardless webhook events.
 *
 * Hosted install: events come from Rentular's partner app and carry
 * links.organisation, the landlord's GoCardless organisation. Each event is
 * applied only to the landlord whose connection has that organisation id, and
 * every lookup (payments, leases, tenants) is limited to that landlord's data.
 * An event without an organisation, or for an organisation nobody connected,
 * is recorded as skipped and never touches anyone's data.
 *
 * Self-hosted install: one landlord, one creditor, events are applied as they
 * come (scope null).
 *
 * The data access is behind WebhookStore so the routing can be tested without
 * a database; createDbWebhookStore() is the real one.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb, webhookEvents, payments, leases, tenants, properties } from "@rentular/db";
import type { GoCardlessEvent } from "../lib/gocardless";
import { findOwnerByOrganisation, revokeConnection } from "../lib/gocardlessConnections";
import {
  transitionPayment,
  GC_PAYMENT_STATUS_MAP,
  GC_MANDATE_STATUS_MAP,
  MANDATE_TERMINAL_STATUSES,
  type PaymentStatus,
} from "./paymentStateMachine";
import { todayInZone } from "../lib/timezone";

/** null: unscoped (self-hosted). A string: only this landlord's data. */
export type OwnerScope = string | null;

export interface WebhookStore {
  eventSeen(eventId: string): Promise<boolean>;
  recordEvent(row: {
    id: string;
    eventId: string;
    resourceType: string;
    action: string;
    resourceId: string;
    payload: unknown;
    status: "processing" | "skipped";
    errorMessage?: string | null;
  }): Promise<void>;
  markEvent(id: string, status: "processed" | "failed", errorMessage?: string): Promise<void>;
  ownerForOrganisation(organisationId: string): Promise<string | null>;
  revokeOwner(ownerId: string, reason: string): Promise<void>;
  findPayment(gcPaymentId: string, owner: OwnerScope): Promise<{ id: string } | null>;
  transitionPayment(paymentId: string, status: PaymentStatus, paidDate?: string): Promise<boolean>;
  findLeaseForMandate(mandateId: string, owner: OwnerScope): Promise<{ id: string } | null>;
  insertPayment(row: { leaseId: string; status: PaymentStatus; gcPaymentId: string; dueDate: string }): Promise<void>;
  leasesForMandate(mandateId: string, owner: OwnerScope): Promise<Array<{ id: string; notes: string | null }>>;
  cancelOpenPayments(leaseIds: string[]): Promise<number>;
  flagLease(leaseId: string, notes: string): Promise<void>;
  clearTenantMandate(mandateId: string, owner: OwnerScope): Promise<void>;
}

export interface WebhookContext {
  hosted: boolean;
  store: WebhookStore;
  today?: () => string;
}

export type EventOutcome = "processed" | "duplicate" | "skipped" | "failed";

function resourceIdOf(event: GoCardlessEvent): string {
  return (
    event.links?.[event.resource_type] ||
    event.links?.payment ||
    event.links?.mandate ||
    event.links?.organisation ||
    ""
  );
}

export async function processGoCardlessEvent(
  event: GoCardlessEvent,
  ctx: WebhookContext,
): Promise<EventOutcome> {
  const { store } = ctx;
  const today = ctx.today ?? (() => todayInZone());

  if (await store.eventSeen(event.id)) {
    console.log(`[Webhook] Skipping duplicate event ${event.id}`);
    return "duplicate";
  }

  const base = {
    id: crypto.randomUUID(),
    eventId: event.id,
    resourceType: event.resource_type,
    action: event.action,
    resourceId: resourceIdOf(event),
    payload: event,
  };

  let owner: OwnerScope = null;
  if (ctx.hosted) {
    const organisationId = event.links?.organisation;
    const resolved = organisationId ? await store.ownerForOrganisation(organisationId) : null;
    if (!resolved) {
      const reason = organisationId
        ? `No landlord has connected GoCardless organisation ${organisationId}`
        : "Event has no organisation link";
      console.warn(`[Webhook] ${event.resource_type}.${event.action} (${event.id}) ignored: ${reason}`);
      await store.recordEvent({ ...base, status: "skipped", errorMessage: reason });
      return "skipped";
    }
    owner = resolved;
  }

  console.log(`[Webhook] Processing ${event.resource_type}.${event.action} (${event.id})`);
  await store.recordEvent({ ...base, status: "processing" });

  try {
    switch (event.resource_type) {
      case "payments":
        await handlePaymentEvent(event, owner, store, today);
        break;
      case "mandates":
        await handleMandateEvent(event, owner, store, today);
        break;
      case "organisations":
        if (event.action === "disconnected" && owner) {
          // The landlord removed Rentular from their GoCardless account.
          await store.revokeOwner(owner, "Disconnected in GoCardless");
          console.log(`[Webhook] Landlord ${owner} disconnected their GoCardless account`);
        }
        break;
      case "payouts":
        console.log(`[Webhook] Payout ${event.links?.payout} ${event.action}`);
        break;
      default:
        console.log(`[Webhook] Unhandled resource type: ${event.resource_type}.${event.action}`);
    }
    await store.markEvent(base.id, "processed");
    return "processed";
  } catch (err) {
    await store.markEvent(base.id, "failed", String(err));
    throw err;
  }
}

async function handlePaymentEvent(
  event: GoCardlessEvent,
  owner: OwnerScope,
  store: WebhookStore,
  today: () => string,
): Promise<void> {
  const gcPaymentId = event.links?.payment;
  const internalStatus: PaymentStatus | undefined = GC_PAYMENT_STATUS_MAP[event.action];
  if (!gcPaymentId || !internalStatus) {
    console.log(`[Webhook] No status mapping for payment action: ${event.action}, skipping`);
    return;
  }

  const payment = await store.findPayment(gcPaymentId, owner);
  if (payment) {
    const transitioned = await store.transitionPayment(
      payment.id,
      internalStatus,
      internalStatus === "paid" ? today() : undefined,
    );
    console.log(
      transitioned
        ? `[Webhook] Payment ${gcPaymentId} transitioned to ${internalStatus}`
        : `[Webhook] Payment ${gcPaymentId} transition to ${internalStatus} skipped (invalid from current state)`
    );
    return;
  }

  // Auto-create unknown payment for review (D-12), on the landlord's own lease.
  const mandateId = event.links?.mandate;
  const lease = mandateId ? await store.findLeaseForMandate(mandateId, owner) : null;
  if (lease) {
    await store.insertPayment({ leaseId: lease.id, status: internalStatus, gcPaymentId, dueDate: today() });
    console.log(`[Webhook] Auto-created payment for ${gcPaymentId} on lease ${lease.id} (needs review)`);
  } else {
    console.log(
      `[Webhook] Cannot resolve payment ${gcPaymentId} - no lease found for mandate ${mandateId || "unknown"}`
    );
  }
}

async function handleMandateEvent(
  event: GoCardlessEvent,
  owner: OwnerScope,
  store: WebhookStore,
  today: () => string,
): Promise<void> {
  const mandateId = event.links?.mandate;
  const mandateStatus = GC_MANDATE_STATUS_MAP[event.action];
  if (!mandateId || !mandateStatus) {
    console.log(`[Webhook] No status mapping for mandate action: ${event.action}, skipping`);
    return;
  }

  if (!MANDATE_TERMINAL_STATUSES.includes(mandateStatus)) {
    console.log(`[Webhook] Mandate ${mandateId} ${event.action}`);
    return;
  }

  const affected = await store.leasesForMandate(mandateId, owner);
  // Cascade-cancel pending payments (D-13)
  const cancelled = await store.cancelOpenPayments(affected.map((l) => l.id));
  for (const lease of affected) {
    const flagNote = `Mandate ${mandateId} ${event.action} on ${today()} -- SEPA collection stopped, action required.`;
    await store.flagLease(lease.id, lease.notes ? `${lease.notes}\n${flagNote}` : flagNote);
  }
  await store.clearTenantMandate(mandateId, owner);
  console.log(
    `[Webhook] Mandate ${mandateId} ${event.action}: flagged ${affected.length} lease(s), cleared mandate, cancelled ${cancelled} pending payments`
  );
}

/** The database-backed store. Every owner-scoped query joins the property owner. */
export function createDbWebhookStore(): WebhookStore {
  const db = getDb();
  return {
    async eventSeen(eventId) {
      const rows = await db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, eventId))
        .limit(1);
      return rows.length > 0;
    },
    async recordEvent(row) {
      await db.insert(webhookEvents).values({
        ...row,
        payload: row.payload as Record<string, unknown>,
        errorMessage: row.errorMessage ?? null,
        receivedAt: new Date(),
        processedAt: row.status === "skipped" ? new Date() : null,
      });
    },
    async markEvent(id, status, errorMessage) {
      await db
        .update(webhookEvents)
        .set(
          status === "processed"
            ? { status, processedAt: new Date() }
            : { status, errorMessage: errorMessage ?? null }
        )
        .where(eq(webhookEvents.id, id));
    },
    async ownerForOrganisation(organisationId) {
      const found = await findOwnerByOrganisation(organisationId);
      return found?.ownerId ?? null;
    },
    async revokeOwner(ownerId, reason) {
      await revokeConnection(ownerId, reason);
    },
    async findPayment(gcPaymentId, owner) {
      const rows = await db
        .select({ id: payments.id })
        .from(payments)
        .innerJoin(leases, eq(payments.leaseId, leases.id))
        .innerJoin(properties, eq(leases.propertyId, properties.id))
        .where(
          owner
            ? and(eq(payments.gocardlessPaymentId, gcPaymentId), eq(properties.ownerId, owner))
            : eq(payments.gocardlessPaymentId, gcPaymentId)
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async transitionPayment(paymentId, status, paidDate) {
      return transitionPayment(paymentId, status, { paidDate });
    },
    async findLeaseForMandate(mandateId, owner) {
      const rows = await db
        .select({ id: leases.id })
        .from(leases)
        .innerJoin(properties, eq(leases.propertyId, properties.id))
        .where(
          owner
            ? and(eq(leases.gocardlessMandateId, mandateId), eq(properties.ownerId, owner))
            : eq(leases.gocardlessMandateId, mandateId)
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async insertPayment(row) {
      await db.insert(payments).values({
        id: crypto.randomUUID(),
        leaseId: row.leaseId,
        status: row.status,
        amount: "0.00",
        dueDate: row.dueDate,
        method: "gocardless",
        gocardlessPaymentId: row.gcPaymentId,
        notes: "Auto-created from webhook - amount unknown, needs review",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    async leasesForMandate(mandateId, owner) {
      return db
        .select({ id: leases.id, notes: leases.notes })
        .from(leases)
        .innerJoin(properties, eq(leases.propertyId, properties.id))
        .where(
          owner
            ? and(eq(leases.gocardlessMandateId, mandateId), eq(properties.ownerId, owner))
            : eq(leases.gocardlessMandateId, mandateId)
        );
    },
    async cancelOpenPayments(leaseIds) {
      if (leaseIds.length === 0) return 0;
      const result = await db
        .update(payments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(inArray(payments.leaseId, leaseIds), inArray(payments.status, ["pending", "processing"])));
      return (result as any)[0]?.affectedRows ?? 0;
    },
    async flagLease(leaseId, notes) {
      await db
        .update(leases)
        .set({ notes, gocardlessMandateId: null, updatedAt: new Date() })
        .where(eq(leases.id, leaseId));
    },
    async clearTenantMandate(mandateId, owner) {
      await db
        .update(tenants)
        .set({ gocardlessMandateId: null, updatedAt: new Date() })
        .where(
          owner
            ? and(eq(tenants.gocardlessMandateId, mandateId), eq(tenants.ownerId, owner))
            : eq(tenants.gocardlessMandateId, mandateId)
        );
    },
  };
}
