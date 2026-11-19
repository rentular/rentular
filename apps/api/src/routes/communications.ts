import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, inArray, or } from "drizzle-orm";
import { getDb, communications, leases, leaseTenants } from "@rentular/db";
import { getRequiredUserId } from "../lib/routeAuth";
import { queueEmail, type CommunicationMeta } from "../jobs/emailQueueWorker";
import { queueSms } from "../jobs/smsQueueWorker";
import { getLeaseEmailRecipients } from "../lib/leaseRecipients";
import {
  getAccessiblePropertyIds,
  getUserPropertyRole,
  hasMinimumRole,
} from "../lib/propertyAccess";
import { getScheduleTimezone, todayInZone, ymdInZone } from "../lib/timezone";

const db = getDb();

export const communicationsRouter = new Hono();

// Helper: get lease IDs for accessible properties
async function getAccessibleLeaseIds(userId: string): Promise<string[]> {
  const accessibleIds = await getAccessiblePropertyIds(userId);
  if (accessibleIds.length === 0) return [];
  const leaseRows = await db.select({ id: leases.id }).from(leases)
    .where(inArray(leases.propertyId, accessibleIds));
  return leaseRows.map(l => l.id);
}

// Stats summary must be registered before /:id to avoid route conflicts
communicationsRouter.get("/stats/summary", async (c) => {
  const userId = getRequiredUserId(c);
  const accessibleLeaseIds = await getAccessibleLeaseIds(userId);

  // Show communications for accessible leases OR created by this user (backwards compatibility)
  let all;
  if (accessibleLeaseIds.length > 0) {
    all = await db.select().from(communications).where(
      or(
        inArray(communications.leaseId, accessibleLeaseIds),
        eq(communications.ownerId, userId)
      )
    );
  } else {
    all = await db.select().from(communications).where(eq(communications.ownerId, userId));
  }

  const byChannel: Record<string, number> = { email: 0, sms: 0, letter: 0 };
  const byStatus: Record<string, number> = { queued: 0, sent: 0, delivered: 0, failed: 0, bounced: 0 };
  const byType: Record<string, number> = {};
  for (const comm of all) {
    byChannel[comm.channel] = (byChannel[comm.channel] || 0) + 1;
    byStatus[comm.status] = (byStatus[comm.status] || 0) + 1;
    byType[comm.type] = (byType[comm.type] || 0) + 1;
  }
  return c.json({ totalSent: all.length, byChannel, byStatus, byType });
});

// List communications with filtering
communicationsRouter.get("/", async (c) => {
  const leaseId = c.req.query("leaseId");
  const channel = c.req.query("channel");   // email, sms, letter
  const type = c.req.query("type");         // payment_reminder_friendly, etc.
  const status = c.req.query("status");     // queued, sent, delivered, failed, bounced
  const propertyId = c.req.query("propertyId");
  const tenantId = c.req.query("tenantId");
  const page = Number(c.req.query("page")) || 1;
  const perPage = Number(c.req.query("perPage")) || 20;

  const userId = getRequiredUserId(c);
  const accessibleLeaseIds = await getAccessibleLeaseIds(userId);

  // Base condition: communications for accessible leases OR owned by user
  const conditions: ReturnType<typeof eq>[] = [];
  if (accessibleLeaseIds.length > 0) {
    conditions.push(
      or(
        inArray(communications.leaseId, accessibleLeaseIds),
        eq(communications.ownerId, userId)
      )!
    );
  } else {
    conditions.push(eq(communications.ownerId, userId));
  }

  if (leaseId) conditions.push(eq(communications.leaseId, leaseId));
  if (channel) conditions.push(eq(communications.channel, channel as any));
  if (type) conditions.push(eq(communications.type, type as any));
  if (status) conditions.push(eq(communications.status, status as any));

  // Filter by propertyId: find all leases for that property on accessible properties
  if (propertyId) {
    const propertyLeases = await db.select({ id: leases.id }).from(leases)
      .where(eq(leases.propertyId, propertyId));
    const leaseIds = propertyLeases.map(l => l.id).filter(id => accessibleLeaseIds.includes(id));
    if (leaseIds.length > 0) {
      conditions.push(inArray(communications.leaseId, leaseIds));
    } else {
      return c.json({ data: [], meta: { total: 0, page, perPage } });
    }
  }

  // Filter by tenantId: find all leases for that tenant via leaseTenants join
  if (tenantId) {
    const tenantLeases = await db.select({ leaseId: leaseTenants.leaseId }).from(leaseTenants)
      .where(eq(leaseTenants.tenantId, tenantId));
    const leaseIds = tenantLeases.map(l => l.leaseId);
    if (leaseIds.length > 0) {
      conditions.push(inArray(communications.leaseId, leaseIds));
    } else {
      return c.json({ data: [], meta: { total: 0, page, perPage } });
    }
  }

  const result = await db.select().from(communications)
    .where(and(...conditions))
    .orderBy(desc(communications.createdAt));
  // Simple pagination (offset-based)
  const offset = (page - 1) * perPage;
  const paged = result.slice(offset, offset + perPage);
  return c.json({ data: paged, meta: { total: result.length, page, perPage } });
});

// Get a single communication with full details
communicationsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const userId = getRequiredUserId(c);

  const result = await db.select().from(communications)
    .where(eq(communications.id, id));
  if (!result[0]) return c.json({ error: "Communication not found" }, 404);

  // Verify access: communication owned by user OR linked to an accessible lease
  if (result[0].ownerId !== userId) {
    if (result[0].leaseId) {
      const lease = await db.select({ propertyId: leases.propertyId }).from(leases)
        .where(eq(leases.id, result[0].leaseId));
      if (!lease[0]) return c.json({ error: "Communication not found" }, 404);
      const role = await getUserPropertyRole(userId, lease[0].propertyId);
      if (!role) return c.json({ error: "Communication not found" }, 404);
    } else {
      return c.json({ error: "Communication not found" }, 404);
    }
  }

  return c.json({ data: result[0] });
});

// Resend a failed communication via the email/SMS queue
communicationsRouter.post("/:id/resend", async (c) => {
  const id = c.req.param("id");
  const userId = getRequiredUserId(c);

  const original = await db.select().from(communications)
    .where(eq(communications.id, id));
  if (!original[0]) return c.json({ error: "Communication not found" }, 404);

  // Check manager+ role: resending requires manager access
  if (original[0].leaseId) {
    const lease = await db.select({ propertyId: leases.propertyId }).from(leases)
      .where(eq(leases.id, original[0].leaseId));
    if (!lease[0]) return c.json({ error: "Communication not found" }, 404);
    const role = await getUserPropertyRole(userId, lease[0].propertyId);
    if (!role || !hasMinimumRole(role, "manager")) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else if (original[0].ownerId !== userId) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  if (!["failed", "bounced"].includes(original[0].status)) {
    return c.json({ error: "Only failed or bounced communications can be resent" }, 400);
  }

  const meta: CommunicationMeta = {
    ownerId: original[0].ownerId,
    leaseId: original[0].leaseId || undefined,
    type: original[0].type as CommunicationMeta["type"],
    recipientName: original[0].recipientName,
    // The new row keeps the original context and says who resent it.
    metadata: {
      ...((original[0].metadata as Record<string, unknown> | null) ?? {}),
      trigger: c.get("tokenId") ? "api" : "manual",
      triggeredBy: userId,
      resendOf: original[0].id,
    },
  };

  if (original[0].channel === "email") {
    await queueEmail(
      { to: original[0].recipientEmail!, subject: original[0].subject || "", body: original[0].body },
      undefined,
      meta,
    );
  } else if (original[0].channel === "sms") {
    await queueSms(
      { to: original[0].recipientPhone!, body: original[0].body },
      undefined,
      meta,
    );
  }

  return c.json({ message: "Communication re-queued for delivery" });
});

// Record that a letter (a registered formal notice) was handed in at the post
// office. The deadline in the letter and any later dispute run from that day,
// which the landlord enters afterwards, so sentAt is the submitted calendar day
// and not the moment of this request. markCommunication() cannot do this: it
// hardcodes sentAt to now and eleven send paths depend on that, hence the
// inline update below.
communicationsRouter.post(
  "/:id/posted",
  zValidator(
    "json",
    z.object({
      postedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reference: z.string().max(64).optional(),
    })
  ),
  async (c) => {
    const id = c.req.param("id");
    const userId = getRequiredUserId(c);
    const { postedOn, reference } = c.req.valid("json");

    const rows = await db.select().from(communications)
      .where(eq(communications.id, id));
    const row = rows[0];
    if (!row) return c.json({ error: "Communication not found" }, 404);

    // Same ownership rule as /:id/resend: a lease-linked row needs manager+ on
    // that property, a lease-less row must belong to the caller.
    if (row.leaseId) {
      const lease = await db.select({ propertyId: leases.propertyId }).from(leases)
        .where(eq(leases.id, row.leaseId));
      if (!lease[0]) return c.json({ error: "Communication not found" }, 404);
      const role = await getUserPropertyRole(userId, lease[0].propertyId);
      if (!role || !hasMinimumRole(role, "manager")) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
    } else if (row.ownerId !== userId) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    if (row.channel !== "letter") {
      return c.json({ error: "Only letters can be marked as posted", code: "not_a_letter" }, 400);
    }

    // A queued letter is being posted for the first time; an already sent one is
    // a correction of a mistyped date or barcode. Anything else is not a letter
    // waiting for the post office.
    if (row.status !== "queued" && row.status !== "sent") {
      return c.json({ error: "This letter cannot be marked as posted", code: "not_markable" }, 400);
    }

    const invalidDate = c.json(
      { error: "The posting date is not valid", code: "invalid_posted_date" },
      400,
    );
    // Noon UTC, so the calendar day is the same in Europe/Brussels and in UTC.
    const sentAt = new Date(`${postedOn}T12:00:00Z`);
    if (isNaN(sentAt.getTime()) || sentAt.toISOString().slice(0, 10) !== postedOn) {
      return invalidDate;
    }
    if (postedOn > todayInZone(getScheduleTimezone())) return invalidDate;
    if (row.createdAt && postedOn < ymdInZone(new Date(row.createdAt), getScheduleTimezone())) {
      return invalidDate;
    }

    const trimmed = reference?.trim() || null;
    const existing = (row.metadata as Record<string, unknown> | null) ?? {};
    // A correction never erases the earlier record: it is evidence too.
    const history = Array.isArray(existing.postedHistory) ? [...existing.postedHistory] : [];
    if (typeof existing.postedOn === "string" && existing.postedOn) {
      history.push({ postedOn: existing.postedOn, reference: row.externalId ?? null });
    }
    const metadata: Record<string, unknown> = {
      ...existing,
      postedOn,
      postedBy: userId,
      postedAt: new Date().toISOString(),
      ...(history.length ? { postedHistory: history } : {}),
    };

    try {
      await db.update(communications).set({
        status: "sent",
        sentAt,
        externalId: trimmed,
        errorMessage: null,
        metadata,
      }).where(eq(communications.id, id));
    } catch (err) {
      console.error("[Communications] mark as posted failed:", err);
      return c.json({ error: "Could not record the posting date" }, 500);
    }

    return c.json({
      data: { id, status: "sent", sentAt: sentAt.toISOString(), postedOn, reference: trimmed },
    });
  }
);

// Send a custom message to a tenant (looks up tenant from lease)
communicationsRouter.post(
  "/send",
  zValidator(
    "json",
    z.object({
      leaseId: z.string().uuid(),
      channel: z.enum(["email", "sms"]),
      subject: z.string().max(500).optional(), // Required for email
      body: z.string().min(1),
    }).refine(
      (data) => data.channel !== "email" || (data.subject && data.subject.length > 0),
      { message: "Subject is required for email" }
    )
  ),
  async (c) => {
    const data = c.req.valid("json");
    const userId = getRequiredUserId(c);

    // Look up the lease and verify access with manager+ role
    const lease = await db.select().from(leases)
      .where(eq(leases.id, data.leaseId)).limit(1);
    if (!lease[0]) return c.json({ error: "Lease not found" }, 404);

    const role = await getUserPropertyRole(userId, lease[0].propertyId);
    if (!role || !hasMinimumRole(role, "manager")) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    // Primary tenant addressed; other tenants on the lease are copied on email.
    const rec = await getLeaseEmailRecipients(data.leaseId);
    const tenant = rec.primary;
    if (!tenant) return c.json({ error: "No primary tenant found for this lease" }, 404);

    const tenantName = `${tenant.firstName} ${tenant.lastName}`.trim();
    const ownerId = lease[0].ownerId;

    if (data.channel === "email") {
      if (!rec.to) {
        return c.json({ error: "Tenant has no email address" }, 400);
      }
      await queueEmail(
        { to: rec.to, cc: rec.cc, subject: data.subject!, body: data.body },
        undefined,
        {
          ownerId,
          leaseId: data.leaseId,
          type: "custom",
          metadata: { trigger: c.get("tokenId") ? "api" : "manual", triggeredBy: userId },
          recipientName: tenantName || rec.to,
        },
      );
    } else if (data.channel === "sms") {
      if (!tenant.phone) {
        return c.json({ error: "Tenant has no phone number" }, 400);
      }
      await queueSms(
        { to: tenant.phone, body: data.body },
        undefined,
        {
          ownerId,
          leaseId: data.leaseId,
          type: "custom",
          metadata: { trigger: c.get("tokenId") ? "api" : "manual", triggeredBy: userId },
          recipientName: tenantName || tenant.phone,
        },
      );
    }

    return c.json({ message: "Message queued for delivery" }, 201);
  }
);
