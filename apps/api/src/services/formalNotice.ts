/**
 * The formal notice of default, joined to real contract data.
 *
 * This is the only module of the feature that touches the database. The words,
 * the money arithmetic and the drawing live in pure modules
 * (services/formalNoticeText.ts and lib/pdfLetter.ts); this one loads the
 * lease, the property, the landlord, the liable tenants, the bank account and
 * the follow-up settings, asks services/contractBalance.ts what is owed, and
 * then renders and logs one letter per liable tenant.
 *
 * Three rules are load-bearing:
 *
 * - No new money computation. What is open comes from loadContractBalance(),
 *   the interest from calculateInterest() and the fee from the lease. A second
 *   formula here would eventually disagree with the reminders.
 * - One letter per liable tenant. A formal notice puts its addressee in
 *   default, so a notice naming only the primary tenant leaves a jointly
 *   liable co-tenant untouched.
 * - Nothing of the letter reaches stdout. The body, the names and the
 *   addresses are tenant personal data; only the lease id and a count are
 *   logged.
 */

import { eq } from "drizzle-orm";
import {
  bankAccounts,
  getDb,
  leaseTenants,
  leases,
  paymentFollowUpSettings,
  properties,
  tenants,
  users,
} from "@rentular/db";
import { formatHouseNumber, type LetterLanguage } from "../lib/belgianFormat";
import { logCommunication, type TriggerMeta } from "../lib/communicationLog";
import { renderLetterPdf } from "../lib/pdfLetter";
import { getScheduleTimezone, todayInZone } from "../lib/timezone";
import { loadContractBalance } from "./contractBalance";
import {
  FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS,
  buildFormalNotice,
  computeFormalNoticeTotals,
  daysPastDue,
  sanitiseExtraParagraph,
  type FormalNoticeArrearsRow,
  type FormalNoticeTotals,
  type PostalParty,
} from "./formalNoticeText";
import { DEFAULT_SETTINGS, calculateInterest } from "./paymentFollowUp";

/** Why no letter was written. Each code has its own sentence in the UI. */
export type FormalNoticeErrorCode =
  | "lease_not_found"
  | "no_tenant"
  | "missing_sender_address"
  | "missing_bank_account"
  | "nothing_owed";

/** The landlord's own address is on the letter, so it cannot be blank. */
export const MISSING_SENDER_ADDRESS_ERROR =
  "Your postal address is missing. Add it under Settings, Profile, and generate the letter again.";

/** Nothing is open on the contract, so there is nothing to put anyone in default for. */
export const FORMAL_NOTICE_NOTHING_OWED_ERROR =
  "Nothing is owed on this contract, so no formal notice was generated";

const MISSING_BANK_ACCOUNT_ERROR =
  "This contract has no bank account, so the letter cannot name where to pay";

const NO_TENANT_ERROR = "This contract has no tenant to address the letter to";

const LEASE_NOT_FOUND_ERROR = "Lease not found";

/** One rendered, logged letter for one liable tenant. */
export type FormalNoticeLetter = {
  tenantId: string;
  recipientName: string;
  language: LetterLanguage;
  addressSource: "correspondence" | "property";
  filename: string;
  /**
   * The PDF as base64. Never a Buffer: this value travels through JSON (and,
   * for other senders, through a queue), and a Buffer does not survive that
   * round trip intact.
   */
  pdfBase64: string;
  communicationId: string | null;
};

/** One month as the letter and its log row state it. */
export type FormalNoticeArrearsEntry = { month: string; dueDate: string; shortfall: number };

export type FormalNoticeResult =
  | {
      ok: true;
      letters: FormalNoticeLetter[];
      totals: FormalNoticeTotals;
      arrears: FormalNoticeArrearsEntry[];
      letterDate: string;
      deadline: string;
      deadlineDays: number;
    }
  | { ok: false; error: string; code: FormalNoticeErrorCode };

function refuse(code: FormalNoticeErrorCode, error: string): FormalNoticeResult {
  return { ok: false, error, code };
}

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

type TenantRow = {
  id: string;
  firstName: string;
  lastName: string;
  language: string | null;
  isPrimary: boolean | null;
  correspondenceStreet: string | null;
  correspondenceStreetNumber: string | null;
  correspondenceBox: string | null;
  correspondencePostalCode: string | null;
  correspondenceCity: string | null;
  correspondenceCountry: string | null;
};

type PropertyRow = {
  street: string;
  streetNumber: string;
  box: string | null;
  postalCode: string;
  city: string;
  country: string | null;
};

/**
 * Where the letter goes: the correspondence address when it is usable, the
 * rented property otherwise. A tenant who has already left, or who sits
 * somewhere else entirely, is only reachable through the first.
 */
function addresseeFor(
  tenant: TenantRow,
  property: PropertyRow,
  name: string,
): { party: PostalParty; source: "correspondence" | "property" } {
  const street = text(tenant.correspondenceStreet);
  const postalCode = text(tenant.correspondencePostalCode);
  const city = text(tenant.correspondenceCity);
  // A half-filled correspondence address is worse than none: a letter without
  // a city is not delivered, while the property address at least is.
  if (street !== "" && postalCode !== "" && city !== "") {
    return {
      source: "correspondence",
      party: {
        name,
        street,
        streetNumber: text(tenant.correspondenceStreetNumber),
        box: text(tenant.correspondenceBox) || null,
        postalCode,
        city,
        country: text(tenant.correspondenceCountry) || "BE",
      },
    };
  }
  return {
    source: "property",
    party: {
      name,
      street: property.street,
      streetNumber: text(property.streetNumber),
      box: text(property.box) || null,
      postalCode: property.postalCode,
      city: property.city,
      country: text(property.country) || "BE",
    },
  };
}

/**
 * Generate the formal notice for one contract: one individually addressed PDF
 * per liable tenant, each logged in communications as the proof of what was
 * written, plus the totals the UI shows before the landlord prints anything.
 */
export async function generateFormalNotice(input: {
  leaseId: string;
  deadlineDays?: number;
  extraParagraph?: string | null;
  trigger?: TriggerMeta;
}): Promise<FormalNoticeResult> {
  const db = getDb();

  const leaseRows = await db.select().from(leases).where(eq(leases.id, input.leaseId)).limit(1);
  const lease = leaseRows[0];
  if (!lease) return refuse("lease_not_found", LEASE_NOT_FOUND_ERROR);

  const propertyRows = await db
    .select({
      street: properties.street,
      streetNumber: properties.streetNumber,
      box: properties.box,
      postalCode: properties.postalCode,
      city: properties.city,
      country: properties.country,
    })
    .from(properties)
    .where(eq(properties.id, lease.propertyId))
    .limit(1);
  const property = propertyRows[0] as PropertyRow | undefined;

  const ownerRows = await db
    .select({
      name: users.name,
      street: users.street,
      streetNumber: users.streetNumber,
      box: users.box,
      postalCode: users.postalCode,
      city: users.city,
      country: users.country,
    })
    .from(users)
    .where(eq(users.id, lease.ownerId))
    .limit(1);
  const owner = ownerRows[0];

  const tenantRows = (await db
    .select({
      id: tenants.id,
      firstName: tenants.firstName,
      lastName: tenants.lastName,
      language: tenants.language,
      isPrimary: leaseTenants.isPrimary,
      correspondenceStreet: tenants.correspondenceStreet,
      correspondenceStreetNumber: tenants.correspondenceStreetNumber,
      correspondenceBox: tenants.correspondenceBox,
      correspondencePostalCode: tenants.correspondencePostalCode,
      correspondenceCity: tenants.correspondenceCity,
      correspondenceCountry: tenants.correspondenceCountry,
    })
    .from(leaseTenants)
    .innerJoin(tenants, eq(tenants.id, leaseTenants.tenantId))
    .where(eq(leaseTenants.leaseId, lease.id))) as TenantRow[];
  if (tenantRows.length === 0) return refuse("no_tenant", NO_TENANT_ERROR);
  const liable = [...tenantRows].sort((a, b) => {
    if (!!a.isPrimary !== !!b.isPrimary) return a.isPrimary ? -1 : 1;
    return text(a.lastName).localeCompare(text(b.lastName));
  });

  if (!lease.bankAccountId) return refuse("missing_bank_account", MISSING_BANK_ACCOUNT_ERROR);
  const bankRows = await db
    .select({ iban: bankAccounts.iban, holderName: bankAccounts.holderName })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, lease.bankAccountId))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) return refuse("missing_bank_account", MISSING_BANK_ACCOUNT_ERROR);

  // Interest is an owner-level setting in this codebase, not a per-lease one.
  // A per-lease interest flag is deliberately NOT introduced here: it would be
  // a second source of truth next to the reminders, and the letter has to claim
  // what the reminders claim.
  const settingsRows = await db
    .select({
      interestEnabled: paymentFollowUpSettings.interestEnabled,
      annualInterestRate: paymentFollowUpSettings.annualInterestRate,
    })
    .from(paymentFollowUpSettings)
    .where(eq(paymentFollowUpSettings.ownerId, lease.ownerId))
    .limit(1);
  const settings = settingsRows[0];
  const interestEnabled = settings ? settings.interestEnabled : DEFAULT_SETTINGS.interestEnabled;
  const annualInterestRate = settings
    ? Number(settings.annualInterestRate || "3.75")
    : DEFAULT_SETTINGS.annualInterestRate;

  // The sender block before any balance work: a letter with a blank sender is
  // not a formal notice, and the landlord has to fix it in Settings first.
  // The house number is left out of this check on purpose: a Belgian address
  // without one is rare but legal, and refusing to write the letter over it
  // would be worse than printing the street alone.
  const senderName = text(owner?.name) || text(bank.holderName);
  const senderStreet = text(owner?.street);
  const senderPostalCode = text(owner?.postalCode);
  const senderCity = text(owner?.city);
  if (senderName === "" || senderStreet === "" || senderPostalCode === "" || senderCity === "") {
    return refuse("missing_sender_address", MISSING_SENDER_ADDRESS_ERROR);
  }
  if (!property) return refuse("lease_not_found", LEASE_NOT_FOUND_ERROR);

  const sender: PostalParty = {
    name: senderName,
    street: senderStreet,
    streetNumber: text(owner?.streetNumber),
    box: text(owner?.box) || null,
    postalCode: senderPostalCode,
    city: senderCity,
    country: text(owner?.country) || "BE",
  };

  const letterDate = todayInZone(getScheduleTimezone());
  const balance = await loadContractBalance(db, lease, letterDate);
  if (!balance || !(balance.owed > 0)) {
    return refuse("nothing_owed", FORMAL_NOTICE_NOTHING_OWED_ERROR);
  }

  // Every month still open on the letter date, oldest first. A settled month,
  // and a month the landlord marked as not counting, are not claimed.
  const rows: FormalNoticeArrearsRow[] = balance.perMonth
    .filter((month) => !month.settled && !month.ignored && month.shortfall > 0)
    .map((month) => ({
      month: month.month,
      dueDate: month.dueDate,
      shortfall: month.shortfall,
      daysPastDue: daysPastDue(month.dueDate, letterDate),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const totals = computeFormalNoticeTotals(
    {
      rows,
      rentOwed: balance.owed,
      interestEnabled,
      annualInterestRate,
      feeEnabled: lease.latePaymentFeeEnabled,
      feeAmount: Number(lease.latePaymentFeeAmount || "15.00"),
    },
    calculateInterest,
  );

  const deadlineDays = input.deadlineDays ?? FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS;
  const extraParagraph = sanitiseExtraParagraph(input.extraParagraph);
  const arrears: FormalNoticeArrearsEntry[] = rows.map((row) => ({
    month: row.month,
    dueDate: row.dueDate,
    shortfall: row.shortfall,
  }));
  const trigger: TriggerMeta = input.trigger ?? { trigger: "manual", triggeredBy: null };

  const letters: FormalNoticeLetter[] = [];
  let deadline = "";
  for (const [index, tenant] of liable.entries()) {
    const name = `${text(tenant.firstName)} ${text(tenant.lastName)}`.trim();
    const { party: addressee, source: addressSource } = addresseeFor(tenant, property, name);
    const propertyAddress = `${property.street} ${formatHouseNumber(
      text(property.streetNumber),
      property.box,
      tenant.language ?? "en",
    )}, ${property.postalCode} ${property.city}`.replace(/\s+/g, " ");

    const letter = buildFormalNotice({
      tenantLanguage: tenant.language ?? "en",
      sender,
      addressee,
      letterDate,
      deadlineDays,
      propertyAddress,
      leaseStartDate: String(lease.startDate),
      rows,
      totals,
      annualInterestRate,
      iban: bank.iban,
      accountHolder: text(bank.holderName) || senderName,
      structuredCommunication: lease.structuredCommunication ?? null,
      extraParagraph,
    });
    deadline = letter.deadline;

    const pdf = await renderLetterPdf(letter.document);
    // The filename is composed from the lease id, the server's date and a
    // counter only. No tenant name and no request text reaches it.
    const filename = `ingebrekestelling-${lease.id}-${letterDate}-${index + 1}.pdf`;

    const communicationId = await logCommunication({
      ownerId: lease.ownerId,
      leaseId: lease.id,
      channel: "letter",
      type: "formal_notice",
      recipientName: name,
      subject: letter.subject,
      body: letter.body,
      metadata: {
        trigger: trigger.trigger,
        triggeredBy: trigger.triggeredBy ?? null,
        tenantId: tenant.id,
        language: letter.language,
        addressSource,
        addresseeLines: letter.document.addresseeLines,
        filename,
        letterDate,
        deadline: letter.deadline,
        deadlineDays,
        arrears,
        rentOwed: totals.rentOwed,
        tableSum: totals.tableSum,
        adjustment: totals.adjustment,
        interest: totals.interest,
        fee: totals.fee,
        totalClaimed: totals.totalClaimed,
        interestSource: "owner_setting",
      },
    });

    letters.push({
      tenantId: tenant.id,
      recipientName: name,
      language: letter.language,
      addressSource,
      filename,
      pdfBase64: pdf.toString("base64"),
      communicationId,
    });
  }

  console.log("[FormalNotice] generated", letters.length, "letter(s) for lease", lease.id);

  return { ok: true, letters, totals, arrears, letterDate, deadline, deadlineDays };
}
