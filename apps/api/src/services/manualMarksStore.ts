import crypto from "crypto";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import {
  bankStatements,
  communications,
  getDb,
  leases,
  paymentAllocations,
  paymentManualMarks,
  paymentReminders,
  payments,
  users,
} from "@rentular/db";
import { loadMonthStatus } from "./monthReceived";
import {
  describeMarks,
  type ManualMarkStore,
  type ManualMarkView,
  type MarkLease,
  type MarkNote,
  type MarkRow,
  type MarkSource,
  type PaymentRow,
  type RowLinks,
  type RowState,
} from "./manualMarks";

type Db = ReturnType<typeof getDb>;

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabelEn(month: string): string {
  const m = Number(month.slice(5, 7));
  return `${MONTHS_EN[m - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

const METHOD_EN: Record<string, string> = {
  cash: "cash",
  bank_transfer: "bank transfer",
  other: "other",
  gocardless: "direct debit",
};

const SOURCE_EN: Record<MarkSource, string> = {
  overview: "",
  other: "",
  api: " via the API",
  magic_link: " via the email link",
  mcp: " via MCP",
};

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function toState(v: unknown): RowState | null {
  const o = parseJson(v);
  if (!o) return null;
  const s = (x: unknown) => (x == null ? null : String(x));
  return {
    status: String(o.status ?? ""),
    amount: String(o.amount ?? "0"),
    rentAmount: s(o.rentAmount),
    chargesAmount: s(o.chargesAmount),
    method: String(o.method ?? "other"),
    paidDate: s(o.paidDate),
    notes: s(o.notes),
    isIgnored: o.isIgnored === true || o.isIgnored === 1 || o.isIgnored === "1",
  };
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

type DbMarkRow = typeof paymentManualMarks.$inferSelect;

function toMark(r: DbMarkRow): MarkRow {
  return {
    id: r.id,
    leaseId: r.leaseId,
    month: r.month,
    paymentId: r.paymentId,
    createdRow: !!r.createdRow,
    beforeState: toState(r.beforeState),
    afterState: toState(r.afterState),
    source: r.source as MarkSource,
    markedBy: r.markedBy,
    markedAt: toDate(r.markedAt) ?? new Date(0),
    undoneAt: toDate(r.undoneAt),
    undoneBy: r.undoneBy,
  };
}

const paymentCols = {
  id: payments.id,
  leaseId: payments.leaseId,
  status: payments.status,
  amount: payments.amount,
  rentAmount: payments.rentAmount,
  chargesAmount: payments.chargesAmount,
  method: payments.method,
  paidDate: payments.paidDate,
  notes: payments.notes,
  isIgnored: payments.isIgnored,
  dueDate: payments.dueDate,
};

function toRow(r: {
  id: string;
  leaseId: string;
  status: string;
  amount: string;
  rentAmount: string | null;
  chargesAmount: string | null;
  method: string;
  paidDate: string | null;
  notes: string | null;
  isIgnored: boolean;
  dueDate: string;
}): PaymentRow {
  return {
    ...r,
    paidDate: r.paidDate ? String(r.paidDate).slice(0, 10) : null,
    dueDate: String(r.dueDate).slice(0, 10),
    isIgnored: !!r.isIgnored,
  };
}

type PaymentStatusValue = typeof payments.$inferInsert.status;
type PaymentMethodValue = typeof payments.$inferInsert.method;

function toSet(set: Partial<RowState>): Record<string, unknown> {
  const out: Record<string, unknown> = { updatedAt: new Date() };
  if (set.status !== undefined) out.status = set.status as PaymentStatusValue;
  if (set.amount !== undefined) out.amount = set.amount;
  if (set.rentAmount !== undefined) out.rentAmount = set.rentAmount;
  if (set.chargesAmount !== undefined) out.chargesAmount = set.chargesAmount;
  if (set.method !== undefined) out.method = set.method as PaymentMethodValue;
  if (set.paidDate !== undefined) out.paidDate = set.paidDate;
  if (set.notes !== undefined) out.notes = set.notes;
  if (set.isIgnored !== undefined) out.isIgnored = set.isIgnored;
  return out;
}

async function personName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const p = (
    await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id)).limit(1)
  )[0];
  return p?.name || p?.email || null;
}

/** Links of several payment rows at once. */
async function linksFor(db: Db, ids: string[]): Promise<Map<string, RowLinks>> {
  const out = new Map<string, RowLinks>();
  for (const id of ids) out.set(id, { bankMatched: false, allocated: false, reminders: 0 });
  if (ids.length === 0) return out;
  const matched = await db
    .select({ id: bankStatements.matchedPaymentId })
    .from(bankStatements)
    .where(inArray(bankStatements.matchedPaymentId, ids));
  for (const m of matched) if (m.id && out.has(m.id)) out.get(m.id)!.bankMatched = true;
  const allocs = await db
    .select({ id: paymentAllocations.paymentId })
    .from(paymentAllocations)
    .where(inArray(paymentAllocations.paymentId, ids));
  for (const a of allocs) if (out.has(a.id)) out.get(a.id)!.allocated = true;
  const rems = await db
    .select({ id: paymentReminders.paymentId, n: sql<number>`COUNT(*)` })
    .from(paymentReminders)
    .where(inArray(paymentReminders.paymentId, ids))
    .groupBy(paymentReminders.paymentId);
  for (const r of rems) if (out.has(r.id)) out.get(r.id)!.reminders = Number(r.n) || 0;
  return out;
}

/** The database-backed store. `db` may be a transaction. */
export function drizzleMarkStore(db: Db, root: Db = db): ManualMarkStore {
  const store: ManualMarkStore = {
    newId: () => crypto.randomUUID(),
    monthStatus: (lease, month) => loadMonthStatus(root, lease, month),
    async monthRows(leaseId, month) {
      const rows = await db
        .select(paymentCols)
        .from(payments)
        .where(and(eq(payments.leaseId, leaseId), like(payments.dueDate, `${month}-%`)));
      return rows.map(toRow);
    },
    async getPayment(id) {
      const rows = await db.select(paymentCols).from(payments).where(eq(payments.id, id)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async insertPayment(row) {
      await db.insert(payments).values({
        id: row.id,
        leaseId: row.leaseId,
        status: row.status as PaymentStatusValue,
        amount: row.amount,
        rentAmount: row.rentAmount,
        chargesAmount: row.chargesAmount,
        dueDate: row.dueDate,
        paidDate: row.paidDate,
        method: row.method as PaymentMethodValue,
        notes: row.notes,
        isIgnored: row.isIgnored,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    async updatePayment(id, set) {
      await db.update(payments).set(toSet(set)).where(eq(payments.id, id));
    },
    async deletePayment(id) {
      await db.delete(payments).where(eq(payments.id, id));
    },
    async insertMark(mark) {
      await db.insert(paymentManualMarks).values({
        id: mark.id,
        leaseId: mark.leaseId,
        month: mark.month,
        paymentId: mark.paymentId,
        createdRow: mark.createdRow,
        beforeState: mark.beforeState,
        afterState: mark.afterState,
        source: mark.source,
        markedBy: mark.markedBy,
        markedAt: mark.markedAt,
      });
    },
    async marksFor(leaseId, month) {
      const rows = await db
        .select()
        .from(paymentManualMarks)
        .where(and(eq(paymentManualMarks.leaseId, leaseId), eq(paymentManualMarks.month, month)))
        .orderBy(desc(paymentManualMarks.markedAt));
      return rows.map(toMark).sort((a, b) => b.markedAt.getTime() - a.markedAt.getTime());
    },
    async getMark(id) {
      const rows = await db.select().from(paymentManualMarks).where(eq(paymentManualMarks.id, id)).limit(1);
      return rows[0] ? toMark(rows[0]) : null;
    },
    async claimUndo(id, by, at) {
      const res = await db
        .update(paymentManualMarks)
        .set({ undoneAt: at, undoneBy: by })
        .where(and(eq(paymentManualMarks.id, id), isNull(paymentManualMarks.undoneAt)));
      const affected = (res as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows;
      return affected === undefined ? true : affected > 0;
    },
    async links(paymentId) {
      return (await linksFor(db, [paymentId])).get(paymentId)!;
    },
    async addNote(note: MarkNote) {
      const who = (await personName(root, note.actor)) ?? note.actor ?? "Rentular";
      const method = METHOD_EN[note.method] ?? note.method;
      const body =
        note.action === "marked"
          ? `Internal note: ${monthLabelEn(note.month)} marked paid by hand (${method}) by ${who}${SOURCE_EN[note.source]}.`
          : `Internal note: the paid mark for ${monthLabelEn(note.month)} was undone by ${who}.`;
      try {
        await root.insert(communications).values({
          id: crypto.randomUUID(),
          ownerId: note.ownerId,
          leaseId: note.leaseId,
          channel: "internal",
          type: "internal_note",
          recipientName: who,
          body,
          status: "sent",
          sentAt: new Date(),
          metadata: {
            kind: "paid_mark",
            action: note.action,
            month: note.month,
            method: note.method,
            amount: note.amount,
            source: note.source,
            markId: note.markId,
            paymentId: note.paymentId,
            trigger: note.source === "magic_link" ? "magic_link" : "manual",
            triggeredBy: note.actor,
          },
        });
      } catch (err) {
        console.error("[ManualMarks] history note failed:", err);
      }
    },
    async transaction(fn) {
      return root.transaction(async (tx) => fn(drizzleMarkStore(tx as unknown as Db, root)));
    },
  };
  return store;
}

/** A lease with what marking and undoing need, or null. */
export async function loadLeaseForMark(db: Db, leaseId: string) {
  const rows = await db
    .select({
      id: leases.id,
      ownerId: leases.ownerId,
      propertyId: leases.propertyId,
      monthlyRent: leases.monthlyRent,
      monthlyCharges: leases.monthlyCharges,
      paymentDay: leases.paymentDay,
    })
    .from(leases)
    .where(eq(leases.id, leaseId))
    .limit(1);
  return rows[0] ?? null;
}

export type LeaseForMark = NonNullable<Awaited<ReturnType<typeof loadLeaseForMark>>> & MarkLease;

/**
 * Active (not undone) manual marks with whether each can be undone, for the
 * given leases (optionally one month) or payment rows.
 */
export async function loadMarkViews(
  db: Db,
  filter: { leaseIds?: string[]; month?: string; paymentIds?: string[] },
): Promise<ManualMarkView[]> {
  const conds = [isNull(paymentManualMarks.undoneAt)];
  if (filter.leaseIds) {
    if (filter.leaseIds.length === 0) return [];
    conds.push(inArray(paymentManualMarks.leaseId, filter.leaseIds));
  }
  if (filter.paymentIds) {
    if (filter.paymentIds.length === 0) return [];
    conds.push(inArray(paymentManualMarks.paymentId, filter.paymentIds));
  }
  if (!filter.leaseIds && !filter.paymentIds) return [];
  if (filter.month) conds.push(eq(paymentManualMarks.month, filter.month));
  const markRows = (await db.select().from(paymentManualMarks).where(and(...conds))).map(toMark);
  if (markRows.length === 0) return [];

  // "Latest" is decided among all active marks of each lease and month, also
  // when the filter was by payment row.
  const pairs = new Set(markRows.map((m) => `${m.leaseId}|${m.month}`));
  const leaseIds = [...new Set(markRows.map((m) => m.leaseId))];
  const all = (
    await db
      .select()
      .from(paymentManualMarks)
      .where(and(isNull(paymentManualMarks.undoneAt), inArray(paymentManualMarks.leaseId, leaseIds)))
  )
    .map(toMark)
    .filter((m) => pairs.has(`${m.leaseId}|${m.month}`));

  const paymentIds = [...new Set(all.map((m) => m.paymentId))];
  const rows = new Map<string, PaymentRow>();
  if (paymentIds.length > 0) {
    const found = await db.select(paymentCols).from(payments).where(inArray(payments.id, paymentIds));
    for (const r of found) rows.set(r.id, toRow(r));
  }
  const links = await linksFor(db, paymentIds);
  const people = [...new Set(all.map((m) => m.markedBy).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (people.length > 0) {
    const ps = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, people));
    for (const p of ps) names.set(p.id, p.name || p.email);
  }
  const wanted = new Set(markRows.map((m) => m.id));
  return describeMarks(all, rows, links, names).filter((v) => wanted.has(v.id));
}
