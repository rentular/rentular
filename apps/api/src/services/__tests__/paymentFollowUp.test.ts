import { describe, it, expect, vi, beforeEach } from "vitest";
import { SOFT_ENFORCEMENT_GRACE_DAYS } from "@rentular/shared";
import {
  determineReminderLevel,
  shouldWaiveFee,
  calculateInterest,
  DEFAULT_SETTINGS,
  decideFinalReminder,
  FINAL_REMINDER_HOLD_DAYS,
  buildLatePaymentOverviewDocument,
  buildFinalReminderAttachment,
  generateLatePaymentPdf,
  type FollowUpSettings,
  type OverduePayment,
  type ReminderLevel,
} from "../paymentFollowUp";
import { formatEur, formatShortDate } from "../../lib/belgianFormat";
import type { LetterDocument } from "../../lib/letterDocument";

// Minimal OverduePayment factory
function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: "pay-1",
    leaseId: "lease-1",
    amount: 850,
    dueDate: "2026-03-01",
    daysPastDue: 5,
    tenantName: "Jan Janssens",
    tenantEmail: "jan@example.com",
    tenantPhone: "+32471000000",
    tenantLanguage: "nl" as const,
    propertyName: "Apartment 2B",
    ownerName: "Pieter Peeters",
    isIgnored: false,
    remindersSent: [] as ReminderLevel[],
    latePaymentFeeEnabled: false,
    latePaymentFeeAmount: 15,
    latePaymentFeeEnforcement: "soft" as const,
    ...overrides,
  };
}

describe("determineReminderLevel (NTF-01/02/03)", () => {
  it("should return 'friendly' when daysPastDue >= friendlyReminderDays and not yet sent", () => {
    const payment = makePayment({ daysPastDue: 0 });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBe("friendly");
  });

  it("should return 'formal' when daysPastDue >= formalReminderDays and formal not yet sent", () => {
    const payment = makePayment({ daysPastDue: 3, remindersSent: ["friendly"] });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBe("formal");
  });

  it("should return 'final' when daysPastDue >= finalReminderDays and final not yet sent", () => {
    const payment = makePayment({ daysPastDue: 6, remindersSent: ["friendly", "formal"] });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBe("final");
  });

  it("should return null when all reminders already sent", () => {
    const payment = makePayment({
      daysPastDue: 10,
      remindersSent: ["friendly", "formal", "final"],
    });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBeNull();
  });

  it("should return null when payment is ignored", () => {
    const payment = makePayment({ daysPastDue: 10, isIgnored: true });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBeNull();
  });

  it("should skip to final if only final threshold is reached and lower levels already sent", () => {
    const payment = makePayment({
      daysPastDue: 6,
      remindersSent: ["friendly", "formal"],
    });
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBe("final");
  });

  it("should escalate to highest unsent level when multiple thresholds crossed", () => {
    // daysPastDue=6 crosses all thresholds, but only friendly was sent
    const payment = makePayment({
      daysPastDue: 6,
      remindersSent: ["friendly"],
    });
    // Should return final (highest first)
    expect(determineReminderLevel(payment, DEFAULT_SETTINGS)).toBe("final");
  });
});

describe("shouldWaiveFee", () => {
  it("should never waive under strict enforcement", () => {
    expect(shouldWaiveFee("strict", "2026-03-01", "2026-03-02")).toBe(false);
  });

  it("should waive under soft enforcement if paid within grace period", () => {
    expect(shouldWaiveFee("soft", "2026-03-01", "2026-03-05")).toBe(true);
  });

  it("should not waive under soft enforcement if paid after grace period", () => {
    expect(shouldWaiveFee("soft", "2026-03-01", "2026-03-15")).toBe(false);
  });

  it("should not waive if not paid yet", () => {
    expect(shouldWaiveFee("soft", "2026-03-01", null)).toBe(false);
  });
});

describe("calculateInterest", () => {
  it("should calculate daily interest correctly", () => {
    // 850 EUR, 30 days, 3.75% annual
    const interest = calculateInterest(850, 30, 3.75);
    const expected = Math.round(850 * (3.75 / 100 / 365) * 30 * 100) / 100;
    expect(interest).toBe(expected);
  });

  it("should return 0 for 0 days past due", () => {
    expect(calculateInterest(850, 0, 3.75)).toBe(0);
  });

  it("should return 0 for 0% rate", () => {
    expect(calculateInterest(850, 30, 0)).toBe(0);
  });
});

describe("decideFinalReminder", () => {
  const notified = new Date("2026-10-12T19:15:00Z");

  it("asks to notify the landlord when nothing happened yet", () => {
    expect(
      decideFinalReminder({ landlordFinalNotifiedAt: null, finalReminderHeldAt: null, now: notified }),
    ).toBe("notify_landlord");
  });

  it("is held once the landlord clicked hold, regardless of elapsed time", () => {
    expect(
      decideFinalReminder({
        landlordFinalNotifiedAt: new Date("2026-10-02T19:15:00Z"),
        finalReminderHeldAt: new Date("2026-10-03T08:00:00Z"),
        now: notified,
      }),
    ).toBe("held");
  });

  it("waits one calendar day after the landlord email", () => {
    expect(
      decideFinalReminder({
        landlordFinalNotifiedAt: notified,
        finalReminderHeldAt: null,
        now: new Date("2026-10-13T19:15:00Z"),
      }),
    ).toBe("wait");
  });

  it("sends two calendar days later even if slightly under 48 hours", () => {
    expect(
      decideFinalReminder({
        landlordFinalNotifiedAt: notified,
        finalReminderHeldAt: null,
        now: new Date("2026-10-14T19:14:00Z"),
      }),
    ).toBe("send");
  });

  it("sends when more than two calendar days have passed", () => {
    expect(
      decideFinalReminder({
        landlordFinalNotifiedAt: notified,
        finalReminderHeldAt: null,
        now: new Date("2026-10-15T08:00:00Z"),
      }),
    ).toBe("send");
  });

  it("sends the same day when holdDays is 0", () => {
    expect(
      decideFinalReminder({
        landlordFinalNotifiedAt: new Date("2026-10-12T08:00:00Z"),
        finalReminderHeldAt: null,
        now: notified,
        holdDays: 0,
      }),
    ).toBe("send");
  });

  it("defaults to a 2 day hold", () => {
    expect(FINAL_REMINDER_HOLD_DAYS).toBe(2);
  });
});

// The overview attachment on the final reminder (D-05, D-29). makePayment is
// deliberately untyped above, so one cast puts it back on the real shape.
function latePayment(overrides: Partial<OverduePayment> = {}): OverduePayment {
  return { ...(makePayment() as unknown as OverduePayment), ...overrides };
}

function withSettings(overrides: Partial<FollowUpSettings> = {}): FollowUpSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function amountRows(document: LetterDocument): Array<{ label: string; value: string; bold?: boolean }> {
  const block = document.blocks.find((b) => b.kind === "amounts");
  if (block?.kind !== "amounts") throw new Error("the overview has no amounts block");
  return block.rows;
}

function labels(document: LetterDocument): string[] {
  return amountRows(document).map((row) => row.label);
}

function paragraphs(document: LetterDocument): string[] {
  return document.blocks
    .filter((b) => b.kind === "paragraph")
    .map((b) => (b.kind === "paragraph" ? b.text : ""));
}

describe("generateLatePaymentPdf (D-05)", () => {
  it("returns real PDF bytes", async () => {
    const pdf = await generateLatePaymentPdf(latePayment(), withSettings());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5000);
  });
});

describe("buildFinalReminderAttachment (D-29)", () => {
  it("carries the PDF as a base64 string nodemailer understands", async () => {
    const attachment = await buildFinalReminderAttachment(latePayment(), withSettings());
    expect(attachment.filename).toBe("late-payment-overview.pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.encoding).toBe("base64");
    expect(typeof attachment.content).toBe("string");
  });

  it("survives the JSON round trip the BullMQ queue puts it through", async () => {
    const attachment = await buildFinalReminderAttachment(latePayment(), withSettings());
    const revived = JSON.parse(JSON.stringify([attachment])) as Array<{
      content: unknown;
      encoding: unknown;
    }>;
    expect(typeof revived[0]!.content).toBe("string");
    expect(revived[0]!.encoding).toBe("base64");
    const bytes = Buffer.from(revived[0]!.content as string, "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("buildLatePaymentOverviewDocument", () => {
  it("states the rent, the due date and the days overdue", () => {
    const rows = amountRows(buildLatePaymentOverviewDocument(latePayment(), withSettings()));
    expect(rows[0]).toEqual({ label: "Verschuldigde huur", value: formatEur(850) });
    expect(rows[1]).toEqual({ label: "Vervaldag", value: formatShortDate("2026-03-01") });
    expect(rows[2]).toEqual({ label: "Dagen te laat", value: "5" });
  });

  it("names the tenant and the property", () => {
    const document = buildLatePaymentOverviewDocument(latePayment(), withSettings());
    expect(document.senderLines).toEqual(["Pieter Peeters"]);
    expect(document.addresseeLines).toEqual(["Jan Janssens"]);
    expect(paragraphs(document)[0]).toBe("Huurder: Jan Janssens\nPand: Apartment 2B");
  });

  it("leaves the place and date line out", () => {
    expect(buildLatePaymentOverviewDocument(latePayment(), withSettings()).placeAndDate).toBe("");
  });

  it("has no interest row when interest is off", () => {
    const document = buildLatePaymentOverviewDocument(
      latePayment(),
      withSettings({ interestEnabled: false }),
    );
    expect(labels(document).some((label) => label.startsWith("Verwijlintresten"))).toBe(false);
  });

  it("has an interest row with the rate when interest is on", () => {
    const document = buildLatePaymentOverviewDocument(
      latePayment(),
      withSettings({ interestEnabled: true, annualInterestRate: 3.75 }),
    );
    const interest = amountRows(document).find((row) => row.label.startsWith("Verwijlintresten"));
    expect(interest?.label).toBe("Verwijlintresten (3,75 % per jaar)");
    expect(interest?.value).toBe(formatEur(calculateInterest(850, 5, 3.75)));
  });

  it("has no fee row when the lease charges no fee", () => {
    const document = buildLatePaymentOverviewDocument(
      latePayment({ latePaymentFeeEnabled: false }),
      withSettings(),
    );
    expect(labels(document)).not.toContain("Vergoeding voor laattijdige betaling");
  });

  it("has a fee row when the lease charges one", () => {
    const document = buildLatePaymentOverviewDocument(
      latePayment({ latePaymentFeeEnabled: true, latePaymentFeeAmount: 15 }),
      withSettings(),
    );
    const fee = amountRows(document).find(
      (row) => row.label === "Vergoeding voor laattijdige betaling",
    );
    expect(fee?.value).toBe(formatEur(15));
  });

  it("totals rent plus interest plus fee, in bold", () => {
    const settings = withSettings({ interestEnabled: true, annualInterestRate: 3.75 });
    const payment = latePayment({ latePaymentFeeEnabled: true, latePaymentFeeAmount: 15 });
    const rows = amountRows(buildLatePaymentOverviewDocument(payment, settings));
    const total = rows[rows.length - 1]!;
    const expected = 850 + calculateInterest(850, 5, 3.75) + 15;
    expect(total.label).toBe("Totaal verschuldigd");
    expect(total.bold).toBe(true);
    expect(total.value).toBe(formatEur(Math.round(expected * 100) / 100));
    expect(rows.filter((row) => row.bold).length).toBe(1);
  });

  it("promises the waiver only under soft enforcement", () => {
    const soft = buildLatePaymentOverviewDocument(
      latePayment({ latePaymentFeeEnabled: true, latePaymentFeeEnforcement: "soft" }),
      withSettings(),
    );
    expect(paragraphs(soft)).toContain(
      `Deze vergoeding vervalt als u binnen ${SOFT_ENFORCEMENT_GRACE_DAYS} dagen betaalt.`,
    );

    const strict = buildLatePaymentOverviewDocument(
      latePayment({ latePaymentFeeEnabled: true, latePaymentFeeEnforcement: "strict" }),
      withSettings(),
    );
    expect(strict.blocks.some((b) => b.kind === "paragraph" && b.text.includes("vervalt"))).toBe(false);

    const noFee = buildLatePaymentOverviewDocument(
      latePayment({ latePaymentFeeEnabled: false, latePaymentFeeEnforcement: "soft" }),
      withSettings(),
    );
    expect(noFee.blocks.some((b) => b.kind === "paragraph" && b.text.includes("vervalt"))).toBe(false);
  });

  it("closes by asking the tenant to pay or get in touch", () => {
    const texts = paragraphs(buildLatePaymentOverviewDocument(latePayment(), withSettings()));
    expect(texts[texts.length - 1]).toBe(
      "Hebt u al betaald of klopt er iets niet, neem dan contact op met uw verhuurder. Anders vragen wij u dit bedrag zo snel mogelijk te betalen.",
    );
  });

  it.each([
    ["nl", "Overzicht laattijdige betaling"],
    ["fr", "Aperçu du paiement en retard"],
    ["de", "Übersicht der verspäteten Zahlung"],
    ["en", "Late payment overview"],
  ] as const)("titles the %s overview", (language, title) => {
    const document = buildLatePaymentOverviewDocument(
      latePayment({ tenantLanguage: language }),
      withSettings(),
    );
    expect(document.language).toBe(language);
    expect(document.title).toBe(title);
    expect(document.subject).toBe(title);
  });
});
