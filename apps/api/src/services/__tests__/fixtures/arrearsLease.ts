/**
 * A realistic Belgian contract in arrears, shared by the formal notice tests.
 *
 * Marie Peeters rents out Bondgenotenlaan 12 bus 3 in Leuven to Lukasz Wojcik
 * (spelled with its real diacritics below, which is what makes the renderer
 * tests meaningful). Three months are open on 18 November 2026: August and
 * October untouched, September partly paid.
 *
 * The amounts here are literals on purpose. The tests assert that
 * computeFormalNoticeTotals reproduces them, so deriving them from the same
 * function would make those assertions circular.
 */

import type { BalanceMonth } from "../../contractBalance";
import { daysPastDue, type FormalNoticeArrearsRow, type FormalNoticeParams } from "../../formalNoticeText";

/** The letter date every fixture number is computed against. */
export const LETTER_DATE = "2026-11-18";

/** The monthly rent plus charges on this contract. */
export const MONTHLY_RENT = 812.45;

/** A liable co-tenant on the same contract, name outside Latin-1 on purpose. */
export const COTENANT_NAME = "Ayşegül Yılmaz";

/**
 * The same formula as calculateInterest in services/paymentFollowUp.ts, copied
 * so the fixture stays free of the database that module pulls in on import.
 */
export function letterInterest(amount: number, days: number, annualRate: number): number {
  return Math.round(amount * (annualRate / 100 / 365) * days * 100) / 100;
}

function monthBefore(month: string, back: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - back;
  const year = y + Math.floor((m - 1) / 12);
  const mm = ((((m - 1) % 12) + 12) % 12) + 1;
  return `${year}-${String(mm).padStart(2, "0")}`;
}

/** The three open months of this contract, oldest first. */
export function arrearsNoticeRows(): FormalNoticeArrearsRow[] {
  return [
    { month: "2026-08", dueDate: "2026-08-01", shortfall: 812.45, daysPastDue: 109 },
    { month: "2026-09", dueDate: "2026-09-01", shortfall: 412.45, daysPastDue: 78 },
    { month: "2026-10", dueDate: "2026-10-01", shortfall: 812.45, daysPastDue: 48 },
  ];
}

/**
 * `count` consecutive unpaid months ending at October 2026, for the page-break
 * case. Ages are computed against LETTER_DATE, like the real caller does.
 */
export function arrearsRows(count: number): FormalNoticeArrearsRow[] {
  const rows: FormalNoticeArrearsRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const month = monthBefore("2026-10", i);
    const dueDate = `${month}-01`;
    rows.push({ month, dueDate, shortfall: MONTHLY_RENT, daysPastDue: daysPastDue(dueDate, LETTER_DATE) });
  }
  return rows;
}

/** Everything buildFormalNotice needs for the Dutch three-month letter. */
export function arrearsNoticeParams(overrides: Partial<FormalNoticeParams> = {}): FormalNoticeParams {
  return {
    tenantLanguage: "nl",
    sender: {
      name: "Marie Peeters",
      street: "Tervuursestraat",
      streetNumber: "97",
      box: null,
      postalCode: "3000",
      city: "Leuven",
      country: "BE",
    },
    addressee: {
      name: "Łukasz Wójcik",
      street: "Bondgenotenlaan",
      streetNumber: "12",
      box: "3",
      postalCode: "3000",
      city: "Leuven",
      country: "BE",
    },
    letterDate: LETTER_DATE,
    deadlineDays: 16,
    propertyAddress: "Bondgenotenlaan 12 bus 3, 3000 Leuven",
    leaseStartDate: "2023-05-01",
    rows: arrearsNoticeRows(),
    totals: {
      tableSum: 2037.35,
      rentOwed: 2037.35,
      adjustment: 0,
      interest: 16.42,
      fee: 15,
      totalClaimed: 2068.77,
    },
    annualInterestRate: 3.75,
    iban: "BE68 5390 0754 7034",
    accountHolder: "Marie Peeters",
    structuredCommunication: "+++123/4567/89002+++",
    extraParagraph: null,
    ...overrides,
  };
}

/**
 * The contract balance view of the same case: the three open months plus a
 * settled month (July) and a month the landlord marked as not counting (June).
 * June still carries a shortfall, so a caller that forgets the ignored flag
 * claims a month it should not.
 */
export function arrearsPerMonth(): BalanceMonth[] {
  return [
    {
      month: "2026-06",
      dueDate: "2026-06-01",
      expected: MONTHLY_RENT,
      received: 0,
      shortfall: MONTHLY_RENT,
      oldRent: null,
      settled: false,
      counted: 0,
      ignored: true,
    },
    {
      month: "2026-07",
      dueDate: "2026-07-01",
      expected: MONTHLY_RENT,
      received: MONTHLY_RENT,
      shortfall: 0,
      oldRent: null,
      settled: true,
      counted: MONTHLY_RENT,
      ignored: false,
    },
    {
      month: "2026-08",
      dueDate: "2026-08-01",
      expected: MONTHLY_RENT,
      received: 0,
      shortfall: 812.45,
      oldRent: null,
      settled: false,
      counted: MONTHLY_RENT,
      ignored: false,
    },
    {
      month: "2026-09",
      dueDate: "2026-09-01",
      expected: MONTHLY_RENT,
      received: 400,
      shortfall: 412.45,
      oldRent: null,
      settled: false,
      counted: MONTHLY_RENT,
      ignored: false,
    },
    {
      month: "2026-10",
      dueDate: "2026-10-01",
      expected: MONTHLY_RENT,
      received: 0,
      shortfall: 812.45,
      oldRent: null,
      settled: false,
      counted: MONTHLY_RENT,
      ignored: false,
    },
  ];
}
