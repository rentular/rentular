import { renderTemplate, type EmailAttachment, type EmailOptions } from "../lib/email";
import { formatEur, formatShortDate, letterLanguage, type LetterLanguage } from "../lib/belgianFormat";
import type { LetterBlock, LetterDocument } from "../lib/letterDocument";
import { renderLetterPdf } from "../lib/pdfLetter";
import { queueEmail, type CommunicationMeta } from "../jobs/emailQueueWorker";
import { queueSms } from "../jobs/smsQueueWorker";
import { normalizePhoneNumber } from "../lib/sms";
import type { TriggerMeta } from "../lib/communicationLog";
import {
  REMINDER_DEFAULTS,
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_SMS_TEMPLATES,
  DEFAULT_INTEREST_RATE,
  DEFAULT_LATE_PAYMENT_FEE,
  SOFT_ENFORCEMENT_GRACE_DAYS,
} from "@rentular/shared";
import type { LatePaymentFeeEnforcement, SupportedLanguage } from "@rentular/shared";
import {
  amountContextText,
  carriedAmountText,
  formatReminderAmount,
  formatReminderDate,
  renderReminderTemplate,
  type CarriedAmount,
  type RemainderContext,
} from "./reminderText";

// Types for the data we expect from the database
export interface OverduePayment {
  paymentId: string;
  leaseId: string;
  amount: number;
  dueDate: string;
  daysPastDue: number;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string | null;
  tenantLanguage: SupportedLanguage; // Tenant's preferred language for communications
  propertyName: string;
  ownerName: string;
  isIgnored: boolean;
  // Which reminders have already been sent
  remindersSent: Array<"friendly" | "formal" | "final">;
  // Per-lease late payment fee settings
  latePaymentFeeEnabled: boolean;
  latePaymentFeeAmount: number;
  latePaymentFeeEnforcement: LatePaymentFeeEnforcement;
  // Set when the amount is only what is still missing for a partly paid month.
  remainder?: RemainderContext | null;
  // Amounts of earlier months reminded together with this one, as agreed with the tenant.
  carried?: CarriedAmount[] | null;
}

export interface FollowUpSettings {
  enabled: boolean;
  friendlyReminderDays: number;
  formalReminderDays: number;
  finalReminderDays: number;
  interestEnabled: boolean;
  annualInterestRate: number;
  friendlySubject: string;
  friendlyBody: string;
  formalSubject: string;
  formalBody: string;
  finalSubject: string;
  finalBody: string;
  // SMS settings
  smsEnabled: boolean;
  smsFriendlyMessage: string;
  smsFormalMessage: string;
  smsFinalMessage: string;
}

// Get default settings using the specified language for templates
function getDefaultSettings(lang: SupportedLanguage = "en"): FollowUpSettings {
  const emailTemplates = DEFAULT_EMAIL_TEMPLATES[lang];
  const smsTemplates = DEFAULT_SMS_TEMPLATES[lang];
  return {
    enabled: true,
    friendlyReminderDays: REMINDER_DEFAULTS.friendly,
    formalReminderDays: REMINDER_DEFAULTS.formal,
    finalReminderDays: REMINDER_DEFAULTS.final,
    interestEnabled: false,
    annualInterestRate: DEFAULT_INTEREST_RATE,
    friendlySubject: emailTemplates.friendly.subject,
    friendlyBody: emailTemplates.friendly.body,
    formalSubject: emailTemplates.formal.subject,
    formalBody: emailTemplates.formal.body,
    finalSubject: emailTemplates.final.subject,
    finalBody: emailTemplates.final.body,
    smsEnabled: false,
    smsFriendlyMessage: smsTemplates.friendly,
    smsFormalMessage: smsTemplates.formal,
    smsFinalMessage: smsTemplates.final,
  };
}

const DEFAULT_SETTINGS: FollowUpSettings = getDefaultSettings("en");

function calculateInterest(
  amount: number,
  daysPastDue: number,
  annualRate: number
): number {
  const dailyRate = annualRate / 100 / 365;
  return Math.round(amount * dailyRate * daysPastDue * 100) / 100;
}

// Check if a late payment fee should be waived under soft enforcement
// Soft: fee is waived if the tenant pays within SOFT_ENFORCEMENT_GRACE_DAYS of the fee notice
// Strict: once charged, the fee remains due regardless of when the tenant pays
export function shouldWaiveFee(
  enforcement: LatePaymentFeeEnforcement,
  feeChargedDate: string,
  paidDate: string | null
): boolean {
  if (enforcement === "strict") return false;
  if (!paidDate) return false;

  const charged = new Date(feeChargedDate);
  const paid = new Date(paidDate);
  const diffDays = Math.floor(
    (paid.getTime() - charged.getTime()) / (1000 * 60 * 60 * 24)
  );
  return diffDays <= SOFT_ENFORCEMENT_GRACE_DAYS;
}

/**
 * Template variables for a reminder, in the tenant's language: amounts in the
 * Belgian euro format, the due date as dd/mm/yyyy, and {{amountContext}}
 * explaining a remaining amount (full sentence for email, short for SMS and
 * WhatsApp).
 */
export function getTemplateVariables(
  payment: OverduePayment,
  settings: FollowUpSettings,
  form: "long" | "short" = "long",
): Record<string, string> {
  const interestAmount = settings.interestEnabled
    ? calculateInterest(
        payment.amount,
        payment.daysPastDue,
        settings.annualInterestRate
      )
    : 0;

  const adminFee = payment.latePaymentFeeEnabled
    ? payment.latePaymentFeeAmount
    : 0;

  const totalOwed = payment.amount + interestAmount + adminFee;

  const lang = payment.tenantLanguage || "en";
  const eur = (n: number) => formatReminderAmount(n, lang);
  return {
    tenantName: payment.tenantName,
    amount: eur(payment.amount),
    dueDate: formatReminderDate(payment.dueDate),
    propertyName: payment.propertyName,
    daysPastDue: payment.daysPastDue.toString(),
    interestAmount: eur(interestAmount),
    adminFee: eur(adminFee),
    totalOwed: eur(totalOwed),
    ownerName: payment.ownerName,
    amountContext: [
      amountContextText(payment.remainder, lang, form),
      carriedAmountText(payment.carried, lang, form),
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export type ReminderLevel = "friendly" | "formal" | "final";

export function determineReminderLevel(
  payment: OverduePayment,
  settings: FollowUpSettings
): ReminderLevel | null {
  if (payment.isIgnored) return null;

  const { daysPastDue, remindersSent } = payment;

  // Check from highest to lowest escalation
  if (
    daysPastDue >= settings.finalReminderDays &&
    !remindersSent.includes("final")
  ) {
    return "final";
  }
  if (
    daysPastDue >= settings.formalReminderDays &&
    !remindersSent.includes("formal")
  ) {
    return "formal";
  }
  if (
    daysPastDue >= settings.friendlyReminderDays &&
    !remindersSent.includes("friendly")
  ) {
    return "friendly";
  }

  return null;
}

// How many calendar days the landlord gets to act after the "third reminder
// pending" email before the automatic third reminder goes to the tenant.
export const FINAL_REMINDER_HOLD_DAYS = 2;

export type FinalReminderDecision = "notify_landlord" | "wait" | "held" | "send";

/**
 * Decide what the automatic worker does when a payment reaches the final
 * reminder level: email the landlord first, wait out the hold period, respect
 * a landlord "hold", or send the third reminder to the tenant.
 *
 * The hold is measured in calendar days (UTC dates), not hours: the worker
 * runs once per evening, so a strict 48h comparison would slip a whole day
 * whenever the run starts a minute earlier than the run that emailed the
 * landlord.
 */
export function decideFinalReminder(input: {
  landlordFinalNotifiedAt: Date | null;
  finalReminderHeldAt: Date | null;
  now: Date;
  holdDays?: number;
}): FinalReminderDecision {
  if (input.finalReminderHeldAt) return "held";
  if (!input.landlordFinalNotifiedAt) return "notify_landlord";

  const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const elapsedDays = Math.floor(
    (dayStart(input.now) - dayStart(input.landlordFinalNotifiedAt)) / 86_400_000,
  );
  return elapsedDays >= (input.holdDays ?? FINAL_REMINDER_HOLD_DAYS) ? "send" : "wait";
}

// TEST PHASE: while this env flag is on, tenant reminders are NOT sent to the
// tenant. Instead they go to the landlord with "TEST PHASE MAIL" in the subject,
// so the owner can verify the flow before real reminders go out. SMS is skipped.
function isReminderTestPhase(): boolean {
  const v = (process.env.PAYMENT_EMAIL_TEST_PHASE || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function sendReminder(
  payment: OverduePayment,
  level: ReminderLevel,
  settings: FollowUpSettings,
  ownerId: string,
  ownerEmail?: string,
  cc?: string,
  trigger: TriggerMeta = { trigger: "schedule" },
): Promise<void> {
  const vars = getTemplateVariables(payment, settings);

  // Use tenant's language for default templates; custom owner templates override
  const lang = payment.tenantLanguage || "en";
  const langDefaults = getDefaultSettings(lang);

  // If the owner has customized templates (differs from any default), use the owner's version.
  // Otherwise, use the tenant's language-specific default templates.
  const ownerEnDefaults = getDefaultSettings("en");

  const getTemplate = (field: "Subject" | "Body") => {
    const settingsKey = `${level}${field}` as keyof FollowUpSettings;
    const ownerValue = settings[settingsKey] as string;
    const enDefault = ownerEnDefaults[settingsKey] as string;
    // If the owner's template matches any language default, use the tenant's language version
    const isCustomized = ownerValue !== enDefault;
    if (isCustomized) return ownerValue;
    return langDefaults[settingsKey] as string;
  };

  const subjectTemplate = getTemplate("Subject");
  const bodyTemplate = getTemplate("Body");

  const emailOptions: EmailOptions = {
    to: payment.tenantEmail,
    cc: cc || undefined,
    subject: renderTemplate(subjectTemplate, { ...vars, amountContext: "" }),
    body: renderReminderTemplate(bodyTemplate, vars, "long"),
  };

  // TEST PHASE: redirect the reminder to the landlord instead of the tenant.
  const testPhase = isReminderTestPhase();
  if (testPhase) {
    if (!ownerEmail) {
      console.log(
        `[PaymentFollowUp] TEST PHASE: no landlord email for lease ${payment.leaseId}, skipping reminder`,
      );
      return;
    }
    emailOptions.to = ownerEmail;
    // Test mail must not reach co-tenants either.
    emailOptions.cc = undefined;
    emailOptions.subject = `TEST PHASE MAIL: ${emailOptions.subject} (would go to ${payment.tenantName} <${payment.tenantEmail}>)`;
  }

  // For final reminders, attach a PDF overview
  if (level === "final") {
    emailOptions.attachments = [await buildFinalReminderAttachment(payment, settings)];
  }

  const logMeta = {
    trigger: trigger.trigger,
    ...(trigger.triggeredBy ? { triggeredBy: trigger.triggeredBy } : {}),
    paymentId: payment.paymentId,
    level,
    amount: payment.amount,
    ...(testPhase ? { testPhase: true } : {}),
  };

  await queueEmail(emailOptions, undefined, {
    ownerId,
    leaseId: payment.leaseId,
    type: `payment_reminder_${level}` as CommunicationMeta["type"],
    recipientName: payment.tenantName,
    metadata: logMeta,
  });

  // Send SMS if enabled and tenant has a phone number (never during test phase)
  if (!testPhase && settings.smsEnabled && payment.tenantPhone) {
    // Use tenant language for SMS defaults, owner custom overrides
    const smsField = `sms${level.charAt(0).toUpperCase() + level.slice(1)}Message` as keyof FollowUpSettings;
    const ownerSms = settings[smsField] as string;
    const enDefaultSms = ownerEnDefaults[smsField] as string;
    const smsTemplate = ownerSms !== enDefaultSms
      ? ownerSms
      : langDefaults[smsField] as string;

    await queueSms({
      to: normalizePhoneNumber(payment.tenantPhone),
      body: renderReminderTemplate(smsTemplate, getTemplateVariables(payment, settings, "short"), "short"),
    }, undefined, {
      ownerId,
      leaseId: payment.leaseId,
      type: `payment_reminder_${level}` as CommunicationMeta["type"],
      recipientName: payment.tenantName,
      metadata: logMeta,
    });
  }
}

/** Every line of the late-payment overview, once per letter language. */
interface LatePaymentLabels {
  title: string;
  tenant: string;
  property: string;
  rentDue: string;
  dueDate: string;
  daysOverdue: string;
  interest(rate: string): string;
  fee: string;
  total: string;
  waiver(days: string): string;
  closing: string;
}

/**
 * The record is typed over LetterLanguage, so a language missing a line does
 * not compile.
 */
const LATE_PAYMENT_LABELS: Record<LetterLanguage, LatePaymentLabels> = {
  nl: {
    title: "Overzicht laattijdige betaling",
    tenant: "Huurder",
    property: "Pand",
    rentDue: "Verschuldigde huur",
    dueDate: "Vervaldag",
    daysOverdue: "Dagen te laat",
    interest: (rate) => `Verwijlintresten (${rate} % per jaar)`,
    fee: "Vergoeding voor laattijdige betaling",
    total: "Totaal verschuldigd",
    waiver: (days) => `Deze vergoeding vervalt als u binnen ${days} dagen betaalt.`,
    closing:
      "Hebt u al betaald of klopt er iets niet, neem dan contact op met uw verhuurder. Anders vragen wij u dit bedrag zo snel mogelijk te betalen.",
  },
  fr: {
    title: "Aperçu du paiement en retard",
    tenant: "Locataire",
    property: "Bien",
    rentDue: "Loyer dû",
    dueDate: "Échéance",
    daysOverdue: "Jours de retard",
    interest: (rate) => `Intérêts de retard (${rate} % par an)`,
    fee: "Indemnité pour paiement tardif",
    total: "Total dû",
    waiver: (days) => `Cette indemnité est annulée si vous payez dans les ${days} jours.`,
    closing:
      "Si vous avez déjà payé ou si quelque chose n'est pas correct, contactez votre bailleur. Sinon, merci de régler ce montant dès que possible.",
  },
  de: {
    title: "Übersicht der verspäteten Zahlung",
    tenant: "Mieter",
    property: "Objekt",
    rentDue: "Geschuldete Miete",
    dueDate: "Fälligkeit",
    daysOverdue: "Tage im Verzug",
    interest: (rate) => `Verzugszinsen (${rate} % pro Jahr)`,
    fee: "Entschädigung für verspätete Zahlung",
    total: "Geschuldeter Gesamtbetrag",
    waiver: (days) => `Diese Entschädigung entfällt, wenn Sie innerhalb von ${days} Tagen zahlen.`,
    closing:
      "Wenn Sie bereits bezahlt haben oder etwas nicht stimmt, wenden Sie sich bitte an Ihren Vermieter. Andernfalls bitten wir Sie, diesen Betrag so bald wie möglich zu begleichen.",
  },
  en: {
    title: "Late payment overview",
    tenant: "Tenant",
    property: "Property",
    rentDue: "Rent amount due",
    dueDate: "Due date",
    daysOverdue: "Days overdue",
    interest: (rate) => `Late payment interest (${rate} % per year)`,
    fee: "Late payment fee",
    total: "Total amount owed",
    waiver: (days) => `This fee is waived if you pay within ${days} days.`,
    closing:
      "If you have already paid or something is not right, please contact your landlord. Otherwise, please settle this amount as soon as you can.",
  },
};

/** The rate the way the reader's language writes a decimal. */
function formatInterestRate(rate: number, language: LetterLanguage): string {
  const text = String(Math.round(rate * 100) / 100);
  return language === "en" ? text : text.replace(".", ",");
}

/**
 * The overview attached to the final reminder, as a drawable document.
 *
 * Pure, and deliberately the same arithmetic the reminder e-mail uses:
 * interest only when the owner switched it on, the fee only when the lease
 * charges one, and the total is the sum of exactly the lines above it.
 */
export function buildLatePaymentOverviewDocument(
  payment: OverduePayment,
  settings: FollowUpSettings,
): LetterDocument {
  const language = letterLanguage(payment.tenantLanguage);
  const labels = LATE_PAYMENT_LABELS[language];
  const interestAmount = settings.interestEnabled
    ? calculateInterest(payment.amount, payment.daysPastDue, settings.annualInterestRate)
    : 0;
  const fee = payment.latePaymentFeeEnabled ? payment.latePaymentFeeAmount : 0;
  const total = Math.round((payment.amount + interestAmount + fee) * 100) / 100;

  const amounts: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: labels.rentDue, value: formatEur(payment.amount) },
    { label: labels.dueDate, value: formatShortDate(payment.dueDate) },
    { label: labels.daysOverdue, value: String(payment.daysPastDue) },
  ];
  if (settings.interestEnabled) {
    amounts.push({
      label: labels.interest(formatInterestRate(settings.annualInterestRate, language)),
      value: formatEur(interestAmount),
    });
  }
  if (payment.latePaymentFeeEnabled) {
    amounts.push({ label: labels.fee, value: formatEur(fee) });
  }
  amounts.push({ label: labels.total, value: formatEur(total), bold: true });

  const blocks: LetterBlock[] = [
    {
      kind: "paragraph",
      text: `${labels.tenant}: ${payment.tenantName}\n${labels.property}: ${payment.propertyName}`,
    },
    { kind: "amounts", rows: amounts },
  ];
  // Under soft enforcement the fee disappears if the tenant pays quickly, so
  // the document has to say so: it is the one line that can still save money.
  if (payment.latePaymentFeeEnabled && payment.latePaymentFeeEnforcement === "soft") {
    blocks.push({ kind: "paragraph", text: labels.waiver(String(SOFT_ENFORCEMENT_GRACE_DAYS)) });
  }
  blocks.push({ kind: "paragraph", text: labels.closing });

  return {
    language,
    title: labels.title,
    senderLines: [payment.ownerName],
    addresseeLines: [payment.tenantName],
    placeAndDate: "",
    subject: labels.title,
    blocks,
  };
}

/** The overview as PDF bytes, drawn by the shared letter renderer. */
export async function generateLatePaymentPdf(
  payment: OverduePayment,
  settings: FollowUpSettings,
): Promise<Buffer> {
  return renderLetterPdf(buildLatePaymentOverviewDocument(payment, settings));
}

/**
 * The attachment as the queue can carry it: a base64 string, never a Buffer.
 * The reminder goes out through BullMQ, which JSON-serialises job data, and a
 * revived Buffer makes nodemailer throw in the worker.
 */
export async function buildFinalReminderAttachment(
  payment: OverduePayment,
  settings: FollowUpSettings,
): Promise<EmailAttachment> {
  const pdf = await generateLatePaymentPdf(payment, settings);
  return {
    filename: "late-payment-overview.pdf",
    content: pdf.toString("base64"),
    encoding: "base64",
    contentType: "application/pdf",
  };
}

export { DEFAULT_SETTINGS, calculateInterest };
