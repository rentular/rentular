/**
 * Marking a rent month paid by hand, and undoing it exactly.
 *
 * Every manual mark (overview, API, the landlord email link, MCP) goes through
 * markMonthPaid or markPaymentPaid. Each call records one mark with the state
 * of the payment row before and after it. undoMonthPaid puts the row back to
 * that before state (or deletes the row when the mark created it), so the
 * month settles, the reminders run and the dashboard adds up as if the mark
 * never happened. Reminders that really went out stay in the history.
 *
 * Restoring a paid row to pending is not a transition the payment state
 * machine allows (paid only moves to refunded or failed). An undo is not a
 * payment event but a correction of a manual entry, so it writes the row
 * directly; the mark row (undone_at, undone_by) is the audit trail.
 *
 * The logic talks to a ManualMarkStore so it can run against the database
 * (manualMarksStore.ts) or an in-memory store in tests.
 */

import type { MonthSettlement } from "./monthReceived";

export type MarkSource = "overview" | "api" | "magic_link" | "mcp" | "other";
export type MarkMethod = "cash" | "bank_transfer" | "other";

/** The fields of a payment row a mark can change. */
export type RowState = {
  status: string;
  amount: string;
  rentAmount: string | null;
  chargesAmount: string | null;
  method: string;
  paidDate: string | null;
  notes: string | null;
  isIgnored: boolean;
};

export type PaymentRow = RowState & {
  id: string;
  leaseId: string;
  dueDate: string;
};

export type MarkRow = {
  id: string;
  leaseId: string;
  month: string;
  paymentId: string;
  createdRow: boolean;
  beforeState: RowState | null;
  afterState: RowState | null;
  source: MarkSource;
  markedBy: string | null;
  markedAt: Date;
  undoneAt: Date | null;
  undoneBy: string | null;
};

export type MarkLease = {
  id: string;
  ownerId: string;
  monthlyRent: string | number | null;
  monthlyCharges: string | number | null;
  paymentDay: number | null;
};

/** What else points at a payment row. */
export type RowLinks = {
  /** A bank statement line is matched to the row. */
  bankMatched: boolean;
  /** Ledger allocations reference the row. */
  allocated: boolean;
  /** Reminders were recorded against the row. */
  reminders: number;
};

/** An internal note for the contract history about a mark or its undo. */
export type MarkNote = {
  leaseId: string;
  ownerId: string;
  action: "marked" | "undone";
  month: string;
  method: string;
  amount: number;
  source: MarkSource;
  markId: string;
  paymentId: string;
  /** The user who marked or undid; null when unknown. */
  actor: string | null;
};

export interface ManualMarkStore {
  monthStatus(lease: MarkLease, month: string): Promise<MonthSettlement & { paidRowId: string | null }>;
  /** The lease's payment rows due in the month. */
  monthRows(leaseId: string, month: string): Promise<PaymentRow[]>;
  getPayment(id: string): Promise<PaymentRow | null>;
  insertPayment(row: PaymentRow): Promise<void>;
  updatePayment(id: string, set: Partial<RowState>): Promise<void>;
  deletePayment(id: string): Promise<void>;
  insertMark(mark: MarkRow): Promise<void>;
  /** All marks of the lease and month, newest first. */
  marksFor(leaseId: string, month: string): Promise<MarkRow[]>;
  getMark(id: string): Promise<MarkRow | null>;
  /** Set undone_at/undone_by when still null; false when it was already undone. */
  claimUndo(id: string, by: string | null, at: Date): Promise<boolean>;
  links(paymentId: string): Promise<RowLinks>;
  /** Best effort: a failed note never fails the mark or the undo. */
  addNote(note: MarkNote): Promise<void>;
  transaction<T>(fn: (store: ManualMarkStore) => Promise<T>): Promise<T>;
  newId(): string;
}

const REMAINDER_NOTE = "remaining amount after partial payment";
const GENERATED_NOTE = "auto-generated expected payment";

export function snapshot(row: PaymentRow): RowState {
  return {
    status: row.status,
    amount: row.amount,
    rentAmount: row.rentAmount,
    chargesAmount: row.chargesAmount,
    method: row.method,
    paidDate: row.paidDate,
    notes: row.notes,
    isIgnored: row.isIgnored,
  };
}

function money(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : Math.round(n * 100);
}

function day(v: string | Date | null | undefined): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** True when two row states are the same, comparing amounts by value and dates by day. */
export function sameState(a: RowState, b: RowState): boolean {
  return (
    a.status === b.status &&
    money(a.amount) === money(b.amount) &&
    money(a.rentAmount) === money(b.rentAmount) &&
    money(a.chargesAmount) === money(b.chargesAmount) &&
    a.method === b.method &&
    day(a.paidDate) === day(b.paidDate) &&
    (a.notes ?? null) === (b.notes ?? null) &&
    !!a.isIgnored === !!b.isIgnored
  );
}

export type UndoBlocker = "row_missing" | "bank_matched" | "allocated" | "changed";

export const UNDO_BLOCKER_MESSAGES: Record<UndoBlocker | "not_latest", string> = {
  row_missing:
    "The payment record of this mark no longer exists, so there is nothing to undo.",
  bank_matched:
    "This payment has since been matched to a bank transaction, so the mark can no longer be undone. Unlink the bank transaction from the payment first, or correct the month in the ledger.",
  allocated:
    "Money has since been assigned to this payment in the ledger, so the mark can no longer be undone. Remove that assignment in the ledger first.",
  changed:
    "This payment was changed after it was marked paid, so putting the old values back is not safe. Correct the payment by hand on the payments page.",
  not_latest: "A later mark for this month exists. Undo that one first.",
};

/** Why a mark cannot be undone right now, or null when it can. */
export function undoBlocker(mark: MarkRow, row: PaymentRow | null, links: RowLinks): UndoBlocker | null {
  if (!row) return "row_missing";
  if (links.bankMatched) return "bank_matched";
  if (links.allocated) return "allocated";
  if (row.status !== "paid") return "changed";
  if (mark.afterState && !sameState(snapshot(row), mark.afterState)) return "changed";
  // A row the mark created cannot carry reminders from before it existed; if
  // some were recorded since, deleting it would lose them.
  if (mark.createdRow && links.reminders > 0) return "changed";
  return null;
}

export type MarkResult = {
  id: string;
  status: "paid";
  already?: true;
  remainder?: number;
  method?: string;
  paidDate?: string;
  markId?: string;
};

async function recordMark(
  store: ManualMarkStore,
  input: {
    lease: MarkLease;
    month: string;
    paymentId: string;
    createdRow: boolean;
    before: RowState | null;
    source: MarkSource;
    actor: string | null;
    now: Date;
  },
): Promise<{ markId: string; after: PaymentRow | null }> {
  const after = await store.getPayment(input.paymentId);
  const markId = store.newId();
  await store.insertMark({
    id: markId,
    leaseId: input.lease.id,
    month: input.month,
    paymentId: input.paymentId,
    createdRow: input.createdRow,
    beforeState: input.before,
    afterState: after ? snapshot(after) : null,
    source: input.source,
    markedBy: input.actor,
    markedAt: input.now,
    undoneAt: null,
    undoneBy: null,
  });
  return { markId, after };
}

async function noteMark(
  store: ManualMarkStore,
  lease: MarkLease,
  input: { action: "marked" | "undone"; mark: Pick<MarkRow, "id" | "month" | "paymentId" | "source">; row: RowState | null; actor: string | null },
): Promise<void> {
  try {
    await store.addNote({
      leaseId: lease.id,
      ownerId: lease.ownerId,
      action: input.action,
      month: input.mark.month,
      method: input.row?.method ?? "other",
      amount: Number(input.row?.amount ?? 0) || 0,
      source: input.mark.source,
      markId: input.mark.id,
      paymentId: input.mark.paymentId,
      actor: input.actor,
    });
  } catch (err) {
    console.error("[ManualMarks] history note failed:", err);
  }
}

/**
 * Mark a lease's rent for a month paid, finding or creating the row, and
 * record the mark. When part of the month already came in, only the remaining
 * amount is recorded (on the open row of the month when there is one).
 */
export async function markMonthPaid(
  store: ManualMarkStore,
  input: {
    lease: MarkLease;
    month: string;
    method: MarkMethod;
    date?: string;
    today: string;
    actor: string | null;
    source: MarkSource;
    now?: Date;
  },
): Promise<MarkResult> {
  const { lease, month, method } = input;
  const now = input.now ?? new Date();
  const status = await store.monthStatus(lease, month);
  const existing = await store.monthRows(lease.id, month);
  const alreadyPaid = existing.find((p) => p.status === "paid" && !p.isIgnored);
  const paidRowId = status.paidRowId ?? alreadyPaid?.id ?? null;
  if (status.settled && paidRowId) return { id: paidRowId, status: "paid", already: true };

  const target = existing.find(
    (p) => !p.isIgnored && (p.status === "pending" || p.status === "processing"),
  );
  const paidDate = input.date || input.today;

  const done = await store.transaction(async (tx) => {
    // Part of the month's rent already came in: record only the remaining amount.
    // An open record for the month is reused for it, so no pending row is left
    // behind to be chased later.
    if (status.received > 0.01 && status.shortfall > 0) {
      const remainder = String(status.shortfall);
      if (target) {
        await tx.updatePayment(target.id, {
          status: "paid",
          paidDate,
          amount: remainder,
          rentAmount: remainder,
          chargesAmount: "0",
          method,
          notes: target.notes ? `${target.notes}\n${REMAINDER_NOTE}` : REMAINDER_NOTE,
        });
        const { markId, after } = await recordMark(tx, {
          lease, month, paymentId: target.id, createdRow: false, before: snapshot(target),
          source: input.source, actor: input.actor, now,
        });
        return { result: { id: target.id, status: "paid" as const, remainder: status.shortfall, markId }, after };
      }
      const id = tx.newId();
      await tx.insertPayment({
        id,
        leaseId: lease.id,
        status: "paid",
        amount: remainder,
        rentAmount: remainder,
        chargesAmount: "0",
        dueDate: status.dueDate,
        paidDate,
        method,
        notes: REMAINDER_NOTE,
        isIgnored: false,
      });
      const { markId, after } = await recordMark(tx, {
        lease, month, paymentId: id, createdRow: true, before: null,
        source: input.source, actor: input.actor, now,
      });
      return { result: { id, status: "paid" as const, remainder: status.shortfall, markId }, after };
    }

    if (!target) {
      const pad = (n: number) => String(n).padStart(2, "0");
      const y = Number(month.slice(0, 4));
      const mo = Number(month.slice(5, 7));
      const lastDay = new Date(y, mo, 0).getDate();
      const d = Math.min(Math.max(1, Math.floor(lease.paymentDay ?? 1) || 1), lastDay);
      const rent = Number(lease.monthlyRent || 0);
      const charges = Number(lease.monthlyCharges || 0);
      const id = tx.newId();
      await tx.insertPayment({
        id,
        leaseId: lease.id,
        status: "paid",
        amount: String(rent + charges),
        rentAmount: String(rent),
        chargesAmount: String(charges),
        dueDate: `${month}-${pad(d)}`,
        paidDate,
        method,
        notes: GENERATED_NOTE,
        isIgnored: false,
      });
      const { markId, after } = await recordMark(tx, {
        lease, month, paymentId: id, createdRow: true, before: null,
        source: input.source, actor: input.actor, now,
      });
      return { result: { id, status: "paid" as const, method, paidDate, markId }, after };
    }

    await tx.updatePayment(target.id, { status: "paid", paidDate, method });
    const { markId, after } = await recordMark(tx, {
      lease, month, paymentId: target.id, createdRow: false, before: snapshot(target),
      source: input.source, actor: input.actor, now,
    });
    return { result: { id: target.id, status: "paid" as const, method, paidDate, markId }, after };
  });

  console.log(
    `[ManualMarks] ${input.source} mark ${done.result.markId}: lease ${lease.id} ${month} paid (row ${done.result.id}) by ${input.actor ?? "unknown"}`,
  );
  await noteMark(store, lease, {
    action: "marked",
    mark: { id: done.result.markId, month, paymentId: done.result.id, source: input.source },
    row: done.after ? snapshot(done.after) : null,
    actor: input.actor,
  });
  return done.result;
}

/**
 * Mark one specific payment row paid (the payments list, the landlord email
 * link) and record the mark against the month the row is due in. A row that
 * is already paid is left alone.
 */
export async function markPaymentPaid(
  store: ManualMarkStore,
  input: {
    lease: MarkLease;
    paymentId: string;
    paidDate: string;
    /** Leave the method as it is when not given. */
    method?: string;
    /** The row's new notes, when they change. */
    notes?: string | null;
    actor: string | null;
    source: MarkSource;
    now?: Date;
  },
): Promise<MarkResult | null> {
  const now = input.now ?? new Date();
  const row = await store.getPayment(input.paymentId);
  if (!row || row.leaseId !== input.lease.id) return null;
  if (row.status === "paid") return { id: row.id, status: "paid", already: true };
  const month = String(row.dueDate).slice(0, 7);

  const done = await store.transaction(async (tx) => {
    await tx.updatePayment(row.id, {
      status: "paid",
      paidDate: input.paidDate,
      ...(input.method ? { method: input.method } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    return recordMark(tx, {
      lease: input.lease, month, paymentId: row.id, createdRow: false, before: snapshot(row),
      source: input.source, actor: input.actor, now,
    });
  });

  console.log(
    `[ManualMarks] ${input.source} mark ${done.markId}: payment ${row.id} (lease ${input.lease.id} ${month}) paid by ${input.actor ?? "unknown"}`,
  );
  await noteMark(store, input.lease, {
    action: "marked",
    mark: { id: done.markId, month, paymentId: row.id, source: input.source },
    row: done.after ? snapshot(done.after) : null,
    actor: input.actor,
  });
  return {
    id: row.id,
    status: "paid",
    paidDate: input.paidDate,
    ...(input.method ? { method: input.method } : {}),
    markId: done.markId,
  };
}

export type UndoResult =
  | { ok: true; already: boolean; markId: string; paymentId: string; month: string; deleted: boolean }
  | { ok: false; status: 404 | 409; code: "no_manual_mark" | UndoBlocker | "not_latest"; error: string };

/**
 * Undo a manual mark: the latest not-yet-undone mark of the lease and month,
 * or the given mark (which must be the latest one of its month). Undoing a
 * mark that is already undone succeeds with already: true.
 */
export async function undoMonthPaid(
  store: ManualMarkStore,
  input: {
    lease: MarkLease;
    month?: string;
    markId?: string;
    actor: string | null;
    now?: Date;
  },
): Promise<UndoResult> {
  const now = input.now ?? new Date();
  const notFound: UndoResult = {
    ok: false,
    status: 404,
    code: "no_manual_mark",
    error: "No manual paid mark found for this contract and month",
  };

  let mark: MarkRow | null = null;
  if (input.markId) {
    mark = await store.getMark(input.markId);
    if (!mark || mark.leaseId !== input.lease.id) return notFound;
    if (input.month && mark.month !== input.month) return notFound;
  } else if (input.month) {
    const marks = await store.marksFor(input.lease.id, input.month);
    mark = marks.find((m) => !m.undoneAt) ?? null;
    if (!mark) {
      const last = marks[0];
      if (!last) return notFound;
      return { ok: true, already: true, markId: last.id, paymentId: last.paymentId, month: last.month, deleted: false };
    }
  } else {
    return notFound;
  }

  if (mark.undoneAt) {
    return { ok: true, already: true, markId: mark.id, paymentId: mark.paymentId, month: mark.month, deleted: false };
  }

  if (input.markId) {
    const latest = (await store.marksFor(mark.leaseId, mark.month)).find((m) => !m.undoneAt);
    if (latest && latest.id !== mark.id) {
      return { ok: false, status: 409, code: "not_latest", error: UNDO_BLOCKER_MESSAGES.not_latest };
    }
  }

  const row = await store.getPayment(mark.paymentId);
  const links = row ? await store.links(row.id) : { bankMatched: false, allocated: false, reminders: 0 };
  const blocker = undoBlocker(mark, row, links);
  if (blocker) return { ok: false, status: 409, code: blocker, error: UNDO_BLOCKER_MESSAGES[blocker] };

  const target = mark;
  const claimed = await store.transaction(async (tx) => {
    if (!(await tx.claimUndo(target.id, input.actor, now))) return false;
    if (target.createdRow || !target.beforeState) {
      await tx.deletePayment(target.paymentId);
    } else {
      await tx.updatePayment(target.paymentId, { ...target.beforeState });
    }
    return true;
  });
  if (!claimed) {
    return { ok: true, already: true, markId: mark.id, paymentId: mark.paymentId, month: mark.month, deleted: false };
  }

  const deleted = target.createdRow || !target.beforeState;
  console.log(
    `[ManualMarks] mark ${mark.id} undone by ${input.actor ?? "unknown"}: lease ${mark.leaseId} ${mark.month}, row ${mark.paymentId} ${deleted ? "deleted" : `restored to ${target.beforeState?.status}`}`,
  );
  await noteMark(store, input.lease, {
    action: "undone",
    mark,
    row: row ? snapshot(row) : null,
    actor: input.actor,
  });
  return { ok: true, already: false, markId: mark.id, paymentId: mark.paymentId, month: mark.month, deleted };
}

/** A mark as the web app shows it, with whether it can be undone. */
export type ManualMarkView = {
  id: string;
  leaseId: string;
  month: string;
  paymentId: string;
  createdRow: boolean;
  method: string | null;
  amount: number | null;
  source: MarkSource;
  markedBy: string | null;
  markedByName: string | null;
  markedAt: string;
  undoable: boolean;
  blockedReason: UndoBlocker | "not_latest" | null;
  blockedMessage: string | null;
};

/** Describe active marks; `latest` is the newest active mark per lease and month. */
export function describeMarks(
  marks: MarkRow[],
  rows: Map<string, PaymentRow>,
  links: Map<string, RowLinks>,
  names: Map<string, string>,
): ManualMarkView[] {
  const latest = new Map<string, MarkRow>();
  for (const m of marks) {
    if (m.undoneAt) continue;
    const key = `${m.leaseId}|${m.month}`;
    const cur = latest.get(key);
    if (!cur || m.markedAt.getTime() > cur.markedAt.getTime()) latest.set(key, m);
  }
  return marks
    .filter((m) => !m.undoneAt)
    .map((m) => {
      const row = rows.get(m.paymentId) ?? null;
      const l = links.get(m.paymentId) ?? { bankMatched: false, allocated: false, reminders: 0 };
      const isLatest = latest.get(`${m.leaseId}|${m.month}`)?.id === m.id;
      const blocker: UndoBlocker | "not_latest" | null = isLatest ? undoBlocker(m, row, l) : "not_latest";
      return {
        id: m.id,
        leaseId: m.leaseId,
        month: m.month,
        paymentId: m.paymentId,
        createdRow: m.createdRow,
        method: m.afterState?.method ?? row?.method ?? null,
        amount: m.afterState ? Number(m.afterState.amount) : row ? Number(row.amount) : null,
        source: m.source,
        markedBy: m.markedBy,
        markedByName: m.markedBy ? names.get(m.markedBy) ?? null : null,
        markedAt: m.markedAt.toISOString(),
        undoable: blocker === null,
        blockedReason: blocker,
        blockedMessage: blocker ? UNDO_BLOCKER_MESSAGES[blocker] : null,
      };
    })
    .sort((a, b) => b.markedAt.localeCompare(a.markedAt));
}
