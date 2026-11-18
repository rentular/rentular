/**
 * The words and the money of a formal notice of default for rent arrears.
 *
 * This module is pure: no database, no pdfkit, no filesystem, no clock. Every
 * fact it needs is a parameter, the letter date included, so a letter is
 * reproducible from its stored inputs. The interest formula arrives as a
 * function for the same reason: services/paymentFollowUp.ts owns the formula
 * but importing it would pull in the database and start the e-mail queue
 * worker.
 */

import type { LetterDocument } from "../lib/letterDocument";

/** Calendar days the tenant gets, counted from the letter date. */
export const FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS = 16;

/** Hard cap on the lines of the landlord's own paragraph. */
const EXTRA_PARAGRAPH_MAX_LINES = 20;

const MS_PER_DAY = 86_400_000;

/** A postal party on an envelope: who sends the letter, who receives it. */
export interface PostalParty {
  name: string;
  street: string;
  streetNumber: string;
  box: string | null;
  postalCode: string;
  city: string;
  country: string;
}

/** One unpaid month as the letter states it. */
export interface FormalNoticeArrearsRow {
  /** YYYY-MM */
  month: string;
  /** YYYY-MM-DD */
  dueDate: string;
  shortfall: number;
  daysPastDue: number;
}

/** Every amount the letter claims, in cents-rounded euro. */
export interface FormalNoticeTotals {
  /** What the months in the table add up to. */
  tableSum: number;
  /** The authoritative rent debt on the contract. */
  rentOwed: number;
  /** rentOwed minus tableSum: negative when money came in elsewhere. */
  adjustment: number;
  interest: number;
  fee: number;
  totalClaimed: number;
}

/** The interest formula, injected (see the module comment). */
export type InterestFn = (amount: number, daysPastDue: number, annualRate: number) => number;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Midnight UTC of a YYYY-MM-DD date, independent of the process timezone. */
function utcDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Calendar days between a month's due date and the letter date, 0 when the due
 * date has not passed yet.
 */
export function daysPastDue(dueDate: string, letterDate: string): number {
  const due = utcDay(dueDate);
  const letter = utcDay(letterDate);
  if (Number.isNaN(due) || Number.isNaN(letter)) return 0;
  return Math.max(0, Math.round((letter - due) / MS_PER_DAY));
}

/** The calendar date the payment must have arrived by. */
export function deadlineDate(letterDate: string, deadlineDays: number): string {
  const letter = utcDay(letterDate);
  if (Number.isNaN(letter)) return letterDate;
  return isoDay(letter + Math.round(deadlineDays) * MS_PER_DAY);
}

/**
 * The landlord's own paragraph, made safe to draw: control characters out,
 * blank-line runs collapsed, at most twenty lines so a wall of newlines cannot
 * inflate the document. Returns null when nothing is left.
 */
export function sanitiseExtraParagraph(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .slice(0, EXTRA_PARAGRAPH_MAX_LINES)
    .join("\n")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The amounts of one notice. The rent claimed is the contract balance, never
 * the sum of the table: a tenant who overpaid one month and underpaid another
 * makes the two differ legitimately, and the difference gets its own labelled
 * line in the letter rather than being hidden.
 *
 * Interest is charged per month, each month with its own age. One call with
 * the total and the oldest age would overstate it.
 */
export function computeFormalNoticeTotals(
  input: {
    rows: FormalNoticeArrearsRow[];
    rentOwed: number;
    interestEnabled: boolean;
    annualInterestRate: number;
    feeEnabled: boolean;
    feeAmount: number;
  },
  interest: InterestFn,
): FormalNoticeTotals {
  const tableSum = round2(input.rows.reduce((sum, row) => sum + row.shortfall, 0));
  const rentOwed = round2(input.rentOwed);
  const interestTotal = input.interestEnabled
    ? round2(
        input.rows.reduce(
          (sum, row) => sum + interest(row.shortfall, row.daysPastDue, input.annualInterestRate),
          0,
        ),
      )
    : 0;
  const fee = input.feeEnabled ? round2(input.feeAmount) : 0;
  return {
    tableSum,
    rentOwed,
    adjustment: round2(rentOwed - tableSum),
    interest: interestTotal,
    fee,
    totalClaimed: round2(rentOwed + interestTotal + fee),
  };
}

/** Everything the letter says, as plain values. */
export interface FormalNoticeParams {
  tenantLanguage: string;
  sender: PostalParty;
  addressee: PostalParty;
  /** YYYY-MM-DD, supplied by the caller: this module has no clock. */
  letterDate: string;
  deadlineDays: number;
  /** Already formatted, e.g. "Bondgenotenlaan 12 bus 3, 3000 Leuven". */
  propertyAddress: string;
  leaseStartDate: string;
  rows: FormalNoticeArrearsRow[];
  totals: FormalNoticeTotals;
  annualInterestRate: number;
  iban: string;
  accountHolder: string;
  structuredCommunication: string | null;
  extraParagraph: string | null;
}

export type { LetterDocument };
