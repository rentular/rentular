/**
 * Marking a month paid by hand and undoing it, run against an in-memory store
 * that behaves like the payments, marks, bank statement, allocation and
 * reminder tables. Month settlement and the contract balance come from the
 * same pure functions the dashboard and the reminder sender use.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  describeMarks,
  markMonthPaid,
  markPaymentPaid,
  undoMonthPaid,
  type ManualMarkStore,
  type MarkLease,
  type MarkNote,
  type MarkRow,
  type PaymentRow,
  type RowLinks,
  type RowState,
} from "../manualMarks";
import { attributedMonth, monthSettlement } from "../monthReceived";
import { contractBalance } from "../contractBalance";
import { isDepositNote } from "../expectedPayments";

type Alloc = { paymentId: string; leaseId: string; periodMonth: string; amount: number };

class MemoryStore implements ManualMarkStore {
  rows = new Map<string, PaymentRow>();
  marks: MarkRow[] = [];
  allocations: Alloc[] = [];
  bankMatched = new Set<string>();
  reminders = new Map<string, number>();
  notes: MarkNote[] = [];
  private seq = 0;
  constructor(private lease: MarkLease) {}

  newId() {
    this.seq += 1;
    return `id-${this.seq}`;
  }
  leaseRows() {
    return [...this.rows.values()].filter((r) => r.leaseId === this.lease.id);
  }
  settlement(month: string) {
    const rows = this.leaseRows().filter((r) => r.status === "paid");
    const allocationSum = this.allocations
      .filter((a) => a.leaseId === this.lease.id && a.periodMonth === month)
      .reduce((s, a) => s + a.amount, 0);
    return monthSettlement({
      rows,
      allocationSum,
      records: [],
      monthlyRent: Number(this.lease.monthlyRent) || 0,
      monthlyCharges: Number(this.lease.monthlyCharges) || 0,
      deductions: [],
      month,
      paymentDay: this.lease.paymentDay,
    });
  }
  async monthStatus(_lease: MarkLease, month: string) {
    const s = this.settlement(month);
    const paid = this.leaseRows().find(
      (r) =>
        r.status === "paid" &&
        !r.isIgnored &&
        !isDepositNote(r.notes) &&
        attributedMonth(r, this.lease.paymentDay) === month,
    );
    return { ...s, paidRowId: paid?.id ?? null };
  }
  async monthRows(leaseId: string, month: string) {
    return [...this.rows.values()]
      .filter((r) => r.leaseId === leaseId && r.dueDate.startsWith(`${month}-`))
      .map((r) => ({ ...r }));
  }
  async getPayment(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async insertPayment(row: PaymentRow) {
    // Like MySQL: decimals come back with two decimals.
    this.rows.set(row.id, {
      ...row,
      amount: Number(row.amount).toFixed(2),
      rentAmount: row.rentAmount == null ? null : Number(row.rentAmount).toFixed(2),
      chargesAmount: row.chargesAmount == null ? null : Number(row.chargesAmount).toFixed(2),
    });
  }
  async updatePayment(id: string, set: Partial<RowState>) {
    const r = this.rows.get(id);
    if (!r) return;
    const next = { ...r, ...set };
    for (const k of ["amount", "rentAmount", "chargesAmount"] as const) {
      const v = next[k];
      if (v != null) (next as Record<string, unknown>)[k] = Number(v).toFixed(2);
    }
    this.rows.set(id, next);
  }
  async deletePayment(id: string) {
    this.rows.delete(id);
  }
  async insertMark(mark: MarkRow) {
    this.marks.push(JSON.parse(JSON.stringify(mark), (k, v) => (k.endsWith("At") && v ? new Date(v) : v)));
  }
  async marksFor(leaseId: string, month: string) {
    return this.marks
      .filter((m) => m.leaseId === leaseId && m.month === month)
      .slice()
      .reverse()
      .sort((a, b) => b.markedAt.getTime() - a.markedAt.getTime());
  }
  async getMark(id: string) {
    return this.marks.find((m) => m.id === id) ?? null;
  }
  async claimUndo(id: string, by: string | null, at: Date) {
    const m = this.marks.find((x) => x.id === id);
    if (!m || m.undoneAt) return false;
    m.undoneAt = at;
    m.undoneBy = by;
    return true;
  }
  async links(paymentId: string): Promise<RowLinks> {
    return {
      bankMatched: this.bankMatched.has(paymentId),
      allocated: this.allocations.some((a) => a.paymentId === paymentId),
      reminders: this.reminders.get(paymentId) ?? 0,
    };
  }
  async addNote(note: MarkNote) {
    this.notes.push(note);
  }
  async transaction<T>(fn: (s: ManualMarkStore) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const LEASE: MarkLease = {
  id: "lease-1",
  ownerId: "owner-1",
  monthlyRent: "780.00",
  monthlyCharges: "0.00",
  paymentDay: 1,
};
const TODAY = "2026-11-14";
const MONTH = "2026-11";

function row(over: Partial<PaymentRow> & { id: string }): PaymentRow {
  return {
    leaseId: LEASE.id,
    status: "pending",
    amount: "780.00",
    rentAmount: "780.00",
    chargesAmount: "0.00",
    method: "bank_transfer",
    paidDate: null,
    notes: "auto-generated expected payment",
    isIgnored: false,
    dueDate: "2026-11-01",
    ...over,
  };
}

function snapshotAll(store: MemoryStore) {
  return JSON.parse(JSON.stringify([...store.rows.values()].sort((a, b) => a.id.localeCompare(b.id))));
}

function balance(store: MemoryStore) {
  return contractBalance({
    lease: { ...LEASE, startDate: "2026-11-01" },
    rows: store.leaseRows(),
    allocations: store.allocations,
    records: [],
    deductions: [],
    today: TODAY,
  });
}

let store: MemoryStore;
let tick = 0;
const at = () => new Date(Date.UTC(2026, 10, 14, 20, 0, tick++));

beforeEach(() => {
  store = new MemoryStore(LEASE);
  tick = 0;
});

describe("each mark branch is undone back to the exact prior state", () => {
  it("open row of the month: pending becomes paid, undo restores every field", async () => {
    await store.insertPayment(row({ id: "p1" }));
    const before = snapshotAll(store);
    const settledBefore = store.settlement(MONTH);

    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    expect(res).toMatchObject({ id: "p1", status: "paid", method: "cash", paidDate: TODAY });
    expect(store.rows.get("p1")).toMatchObject({ status: "paid", method: "cash", paidDate: TODAY });
    expect(store.settlement(MONTH).settled).toBe(true);
    expect(store.marks).toHaveLength(1);
    expect(store.marks[0]).toMatchObject({ createdRow: false, source: "overview", markedBy: "user-A" });
    expect(store.marks[0]!.beforeState).toMatchObject({ status: "pending", method: "bank_transfer", paidDate: null });

    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: true, already: false, deleted: false, paymentId: "p1" });
    expect(snapshotAll(store)).toEqual(before);
    expect(store.settlement(MONTH)).toEqual(settledBefore);
  });

  it("no row for the month: the created row is removed again", async () => {
    const settledBefore = store.settlement(MONTH);
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "api", now: at(),
    });
    expect(store.rows.get(res.id)).toMatchObject({
      status: "paid", amount: "780.00", dueDate: "2026-11-01", paidDate: TODAY, method: "cash",
    });
    expect(store.marks[0]).toMatchObject({ createdRow: true, beforeState: null, source: "api" });

    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: true, deleted: true });
    expect(store.rows.size).toBe(0);
    expect(store.settlement(MONTH)).toEqual(settledBefore);
  });

  it("partly paid with an open row: the open row takes the remainder, undo restores amount and notes", async () => {
    await store.insertPayment(row({ id: "part", status: "paid", amount: "500.00", rentAmount: "500.00", paidDate: "2026-11-03", notes: null }));
    await store.insertPayment(row({ id: "open" }));
    const before = snapshotAll(store);
    const settledBefore = store.settlement(MONTH);
    expect(settledBefore).toMatchObject({ received: 500, shortfall: 280 });

    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    expect(res).toMatchObject({ id: "open", remainder: 280 });
    expect(store.rows.get("open")).toMatchObject({
      status: "paid", amount: "280.00", rentAmount: "280.00", chargesAmount: "0.00",
      notes: "auto-generated expected payment\nremaining amount after partial payment",
    });
    expect(store.settlement(MONTH).settled).toBe(true);

    await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(snapshotAll(store)).toEqual(before);
    expect(store.settlement(MONTH)).toEqual(settledBefore);
  });

  it("partly paid without an open row: the inserted remainder row is removed again", async () => {
    await store.insertPayment(row({ id: "part", status: "paid", amount: "500.00", rentAmount: "500.00", paidDate: "2026-11-03", notes: null }));
    const before = snapshotAll(store);
    const settledBefore = store.settlement(MONTH);

    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    expect(res.id).not.toBe("part");
    expect(store.rows.get(res.id)).toMatchObject({ status: "paid", amount: "280.00", notes: "remaining amount after partial payment" });

    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: true, deleted: true });
    expect(snapshotAll(store)).toEqual(before);
    expect(store.settlement(MONTH)).toEqual(settledBefore);
  });

  it("a settled month is not marked again and records no mark", async () => {
    await store.insertPayment(row({ id: "p1", status: "paid", paidDate: "2026-11-01" }));
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    expect(res).toEqual({ id: "p1", status: "paid", already: true });
    expect(store.marks).toHaveLength(0);
    expect(store.notes).toHaveLength(0);
  });
});

describe("undo is refused when a blind restore is unsafe", () => {
  async function markOpenRow() {
    await store.insertPayment(row({ id: "p1" }));
    await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
  }

  it("matched to a bank transaction since", async () => {
    await markOpenRow();
    store.bankMatched.add("p1");
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, status: 409, code: "bank_matched" });
    expect(store.rows.get("p1")!.status).toBe("paid");
    expect(store.marks[0]!.undoneAt).toBeNull();
  });

  it("allocated in the ledger since", async () => {
    await markOpenRow();
    store.allocations.push({ paymentId: "p1", leaseId: LEASE.id, periodMonth: MONTH, amount: 780 });
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, status: 409, code: "allocated" });
  });

  it("changed since (amount edited)", async () => {
    await markOpenRow();
    await store.updatePayment("p1", { amount: "700" });
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, status: 409, code: "changed" });
    expect(store.rows.get("p1")!.amount).toBe("700.00");
  });

  it("no longer paid (refunded since)", async () => {
    await markOpenRow();
    await store.updatePayment("p1", { status: "refunded" });
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, code: "changed" });
  });

  it("a created row that got reminders recorded since", async () => {
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    store.reminders.set(res.id, 1);
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, code: "changed" });
    expect(store.rows.has(res.id)).toBe(true);
  });
});

describe("idempotence and order", () => {
  it("a second undo answers already and changes nothing", async () => {
    await store.insertPayment(row({ id: "p1" }));
    await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    const first = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    const after = snapshotAll(store);
    const second = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    const byId = await undoMonthPaid(store, { lease: LEASE, markId: first.ok ? first.markId : "", actor: "user-A", now: at() });
    expect(second).toMatchObject({ ok: true, already: true });
    expect(byId).toMatchObject({ ok: true, already: true });
    expect(snapshotAll(store)).toEqual(after);
    expect(store.notes.filter((n) => n.action === "undone")).toHaveLength(1);
  });

  it("no mark at all for the month: 404 no_manual_mark", async () => {
    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: false, status: 404, code: "no_manual_mark" });
  });

  it("a mark of another lease is not found", async () => {
    await store.insertPayment(row({ id: "p1" }));
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    const undo = await undoMonthPaid(store, {
      lease: { ...LEASE, id: "lease-2" }, markId: res.markId, actor: "user-B", now: at(),
    });
    expect(undo).toMatchObject({ ok: false, status: 404 });
  });

  it("only the latest mark of a month can be undone; by month the latest goes first", async () => {
    await store.insertPayment(row({ id: "a", amount: "400.00", rentAmount: "400.00" }));
    await store.insertPayment(row({ id: "b", amount: "380.00", rentAmount: "380.00", dueDate: "2026-11-15" }));
    const ma = await markPaymentPaid(store, { lease: LEASE, paymentId: "a", paidDate: TODAY, method: "cash", actor: "user-A", source: "other", now: at() });
    const mb = await markPaymentPaid(store, { lease: LEASE, paymentId: "b", paidDate: TODAY, method: "cash", actor: "user-A", source: "other", now: at() });

    const early = await undoMonthPaid(store, { lease: LEASE, markId: ma!.markId, actor: "user-A", now: at() });
    expect(early).toMatchObject({ ok: false, status: 409, code: "not_latest" });

    const views = describeMarks(store.marks, store.rows, new Map(), new Map());
    expect(views.find((v) => v.id === ma!.markId)).toMatchObject({ undoable: false, blockedReason: "not_latest" });
    expect(views.find((v) => v.id === mb!.markId)).toMatchObject({ undoable: true, blockedReason: null });

    const first = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(first).toMatchObject({ ok: true, markId: mb!.markId, paymentId: "b" });
    const second = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(second).toMatchObject({ ok: true, markId: ma!.markId, paymentId: "a" });
    expect(store.rows.get("a")!.status).toBe("pending");
    expect(store.rows.get("b")!.status).toBe("pending");
  });
});

describe("the landlord email link", () => {
  it("marks the exact row, as the landlord, and the undo restores its old status and method", async () => {
    await store.insertPayment(row({ id: "p1", status: "failed", method: "gocardless" }));
    const before = snapshotAll(store);
    const res = await markPaymentPaid(store, {
      lease: LEASE, paymentId: "p1", paidDate: TODAY, actor: LEASE.ownerId, source: "magic_link", now: at(),
    });
    // The method is left alone, as the email link always did.
    expect(store.rows.get("p1")).toMatchObject({ status: "paid", method: "gocardless", paidDate: TODAY });
    expect(store.marks[0]).toMatchObject({ source: "magic_link", markedBy: "owner-1", month: MONTH });

    const again = await markPaymentPaid(store, {
      lease: LEASE, paymentId: "p1", paidDate: TODAY, actor: LEASE.ownerId, source: "magic_link", now: at(),
    });
    expect(again).toEqual({ id: "p1", status: "paid", already: true });
    expect(store.marks).toHaveLength(1);

    const undo = await undoMonthPaid(store, { lease: LEASE, markId: res!.markId, actor: LEASE.ownerId, now: at() });
    expect(undo).toMatchObject({ ok: true, already: false });
    expect(snapshotAll(store)).toEqual(before);
  });

  it("a payment of another lease is not marked", async () => {
    await store.insertPayment(row({ id: "p1", leaseId: "lease-2" }));
    const res = await markPaymentPaid(store, {
      lease: LEASE, paymentId: "p1", paidDate: TODAY, actor: "owner-1", source: "magic_link", now: at(),
    });
    expect(res).toBeNull();
    expect(store.rows.get("p1")!.status).toBe("pending");
  });
});

describe("contract history notes", () => {
  it("the mark and the undo each add one internal note with who, month, method and amount", async () => {
    await store.insertPayment(row({ id: "p1" }));
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-B", now: at() });
    expect(store.notes).toEqual([
      expect.objectContaining({ action: "marked", month: MONTH, method: "cash", amount: 780, source: "overview", markId: res.markId, paymentId: "p1", actor: "user-A", leaseId: LEASE.id, ownerId: LEASE.ownerId }),
      expect.objectContaining({ action: "undone", month: MONTH, method: "cash", amount: 780, markId: res.markId, actor: "user-B" }),
    ]);
    expect(store.marks[0]).toMatchObject({ undoneBy: "user-B" });
  });

  it("a failing note never fails the mark", async () => {
    await store.insertPayment(row({ id: "p1" }));
    store.addNote = async () => {
      throw new Error("db down");
    };
    const res = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "overview", now: at(),
    });
    expect(res.markId).toBeTruthy();
  });
});

describe("the reminder chain can run again after an undo", () => {
  it("friendly reminder sent, mark paid (nothing owed), undo (owed again, the reminder still counted)", async () => {
    await store.insertPayment(row({ id: "p1" }));
    // The friendly reminder went out for the open row.
    store.reminders.set("p1", 1);
    expect(balance(store).owed).toBe(780);

    await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "api", now: at(),
    });
    // send-reminder refuses with nothing_owed when the contract owes nothing.
    expect(balance(store).owed).toBe(0);

    const undo = await undoMonthPaid(store, { lease: LEASE, month: MONTH, actor: "user-A", now: at() });
    expect(undo).toMatchObject({ ok: true });
    // Owed again, so send-reminder is accepted again; the reminder stays recorded.
    expect(balance(store).owed).toBe(780);
    expect(store.reminders.get("p1")).toBe(1);

    // And the next day's run can mark it paid again.
    const again = await markMonthPaid(store, {
      lease: LEASE, month: MONTH, method: "cash", today: TODAY, actor: "user-A", source: "api", now: at(),
    });
    expect(again.markId).toBeTruthy();
    expect(balance(store).owed).toBe(0);
  });
});
