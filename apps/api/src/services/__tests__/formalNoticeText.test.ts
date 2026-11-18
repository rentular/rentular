import { describe, it, expect, vi } from "vitest";
import {
  FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS,
  computeFormalNoticeTotals,
  daysPastDue,
  deadlineDate,
  sanitiseExtraParagraph,
} from "../formalNoticeText";
import { arrearsNoticeRows, arrearsRows, letterInterest, LETTER_DATE } from "./fixtures/arrearsLease";

describe("daysPastDue", () => {
  it("counts calendar days from the due date to the letter date", () => {
    expect(daysPastDue("2026-08-01", LETTER_DATE)).toBe(109);
    expect(daysPastDue("2026-09-01", LETTER_DATE)).toBe(78);
    expect(daysPastDue("2026-10-01", LETTER_DATE)).toBe(48);
  });

  it("is 0 on the due date and for a due date still to come", () => {
    expect(daysPastDue("2026-11-18", LETTER_DATE)).toBe(0);
    expect(daysPastDue("2026-12-01", LETTER_DATE)).toBe(0);
  });
});

describe("deadlineDate", () => {
  it("adds calendar days to the letter date", () => {
    expect(deadlineDate(LETTER_DATE, 16)).toBe("2026-12-04");
    expect(deadlineDate(LETTER_DATE, 30)).toBe("2026-12-18");
  });

  it("rolls over into the next year", () => {
    expect(deadlineDate("2026-12-20", 16)).toBe("2027-01-05");
  });

  it("does not shift when the span crosses the local summer time change", () => {
    // Europe/Brussels moves to summer time on 29 March 2026. Local-midnight
    // arithmetic would land on 5 April; UTC arithmetic gives 6 April.
    expect(deadlineDate("2026-03-21", 16)).toBe("2026-04-06");
    expect(deadlineDate("2026-10-18", 16)).toBe("2026-11-03");
  });

  it("defaults to 16 calendar days", () => {
    expect(FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS).toBe(16);
    expect(deadlineDate(LETTER_DATE, FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS)).toBe("2026-12-04");
  });
});

describe("computeFormalNoticeTotals", () => {
  const base = {
    rows: arrearsNoticeRows(),
    rentOwed: 2037.35,
    interestEnabled: true,
    annualInterestRate: 3.75,
    feeEnabled: true,
    feeAmount: 15,
  };

  it("sums the months, charges interest per month and adds the fee once", () => {
    const interest = vi.fn(letterInterest);
    const totals = computeFormalNoticeTotals(base, interest);

    expect(totals.tableSum).toBe(2037.35);
    expect(totals.rentOwed).toBe(2037.35);
    expect(totals.adjustment).toBe(0);
    expect(totals.interest).toBe(16.42);
    expect(totals.fee).toBe(15);
    expect(totals.totalClaimed).toBe(2068.77);

    // One call per month, each with that month's own age (not the total).
    expect(interest.mock.calls).toEqual([
      [812.45, 109, 3.75],
      [412.45, 78, 3.75],
      [812.45, 48, 3.75],
    ]);
  });

  it("leaves interest out and never calls the interest function when it is off", () => {
    const interest = vi.fn(letterInterest);
    const totals = computeFormalNoticeTotals({ ...base, interestEnabled: false }, interest);

    expect(interest).not.toHaveBeenCalled();
    expect(totals.interest).toBe(0);
    expect(totals.totalClaimed).toBe(2052.35);
  });

  it("leaves the fee out when the contract does not carry one", () => {
    const totals = computeFormalNoticeTotals({ ...base, feeEnabled: false }, letterInterest);
    expect(totals.fee).toBe(0);
    expect(totals.totalClaimed).toBe(2053.77);
  });

  it("reconciles a balance that is lower than the months add up to", () => {
    const totals = computeFormalNoticeTotals({ ...base, rentOwed: 1837.35 }, letterInterest);

    expect(totals.tableSum).toBe(2037.35);
    expect(totals.rentOwed).toBe(1837.35);
    expect(totals.adjustment).toBe(-200);
    // The claim follows the contract balance, not the table.
    expect(totals.totalClaimed).toBe(1868.77);
  });

  it("reconciles a balance that is higher than the months add up to", () => {
    const totals = computeFormalNoticeTotals({ ...base, rentOwed: 2087.35 }, letterInterest);
    expect(totals.adjustment).toBe(50);
    expect(totals.totalClaimed).toBe(2118.77);
  });

  it("handles a debt that sits in no open month", () => {
    const totals = computeFormalNoticeTotals(
      { ...base, rows: [], rentOwed: 500, interestEnabled: true },
      letterInterest,
    );
    expect(totals.tableSum).toBe(0);
    expect(totals.adjustment).toBe(500);
    expect(totals.interest).toBe(0);
    expect(totals.totalClaimed).toBe(515);
  });

  it("works over a twelve-month table", () => {
    const totals = computeFormalNoticeTotals(
      { ...base, rows: arrearsRows(12), rentOwed: 9749.4 },
      letterInterest,
    );
    expect(totals.tableSum).toBe(9749.4);
    expect(totals.adjustment).toBe(0);
    expect(totals.interest).toBeGreaterThan(0);
  });
});

describe("sanitiseExtraParagraph", () => {
  it("returns null for nothing to say", () => {
    expect(sanitiseExtraParagraph(null)).toBeNull();
    expect(sanitiseExtraParagraph(undefined)).toBeNull();
    expect(sanitiseExtraParagraph("")).toBeNull();
    expect(sanitiseExtraParagraph("   \n\t  \n ")).toBeNull();
  });

  it("trims and keeps the text", () => {
    expect(sanitiseExtraParagraph("  Ik ben bereid een afbetalingsplan te bespreken.  ")).toBe(
      "Ik ben bereid een afbetalingsplan te bespreken.",
    );
  });

  it("removes control characters but keeps newlines", () => {
    expect(sanitiseExtraParagraph("a\u0000b\u0007c\u001bd")).toBe("abcd");
    expect(sanitiseExtraParagraph("regel een\r\nregel twee")).toBe("regel een\nregel twee");
  });

  it("collapses runs of newlines to one blank line", () => {
    expect(sanitiseExtraParagraph("een\n\n\n\n\ntwee")).toBe("een\n\ntwee");
    expect(sanitiseExtraParagraph("een\n\ntwee")).toBe("een\n\ntwee");
  });

  it("keeps at most twenty lines", () => {
    const many = Array.from({ length: 40 }, (_, i) => `regel ${i + 1}`).join("\n");
    const out = sanitiseExtraParagraph(many);
    expect(out).not.toBeNull();
    expect(out!.split("\n")).toHaveLength(20);
    expect(out!.split("\n")[19]).toBe("regel 20");
  });

  it("cannot inflate the letter with a wall of newlines", () => {
    const out = sanitiseExtraParagraph(`start${"\n".repeat(400)}end`);
    expect(out).toBe("start\n\nend");
  });
});
