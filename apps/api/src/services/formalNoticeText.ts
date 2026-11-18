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

import {
  formatCountry,
  formatEur,
  formatHouseNumber,
  formatLongDate,
  formatMonthYear,
  formatShortDate,
  letterLanguage,
  type LetterLanguage,
} from "../lib/belgianFormat";
import type { LetterBlock, LetterDocument } from "../lib/letterDocument";

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

/**
 * Every sentence the letter can print, once per language. The record is typed
 * over LetterLanguage, so a language missing a sentence does not compile.
 *
 * The wording carries the legal substance: the letter names itself a formal
 * notice of default, and the only consequence it announces is a case before
 * the justice of the peace. It cites no statute: Belgian obligations law was
 * recodified and a wrong citation in a document that ends up in a court file
 * is worse than none. Do not add sentences here without a decision behind it.
 */
export interface FormalNoticeCopy {
  subject: string;
  reference(propertyAddress: string, startDate: string): string;
  salutation(name: string): string;
  intro: string;
  notice: string;
  headerPeriod: string;
  headerDueDate: string;
  headerAmount: string;
  rentArrears: string;
  credited: string;
  otherBalance: string;
  interest(rate: string): string;
  fee: string;
  total: string;
  payment(total: string, iban: string, holder: string, reference: string): string;
  paymentWithoutReference(total: string, iban: string, holder: string): string;
  deadline(date: string): string;
  consequence: string;
  closing: string;
}

export const FORMAL_NOTICE_COPY: Record<LetterLanguage, FormalNoticeCopy> = {
  nl: {
    subject: "Aangetekend: ingebrekestelling wegens huurachterstal",
    reference: (propertyAddress, startDate) =>
      `Betreft: de huurovereenkomst voor ${propertyAddress}, in werking getreden op ${startDate}.`,
    salutation: (name) => `Geachte ${name},`,
    intro:
      "Volgens mijn administratie zijn de volgende huurbedragen op vandaag niet of niet volledig betaald:",
    notice: "Met deze brief stel ik u formeel in gebreke voor de betaling van deze achterstal.",
    headerPeriod: "Periode",
    headerDueDate: "Vervaldag",
    headerAmount: "Openstaand bedrag",
    rentArrears: "Achterstallige huur",
    credited: "Reeds ontvangen en verrekend",
    otherBalance: "Overig openstaand huursaldo",
    interest: (rate) => `Verwijlintresten (${rate} % per jaar)`,
    fee: "Vergoeding voor laattijdige betaling",
    total: "Totaal verschuldigd",
    payment: (total, iban, holder, reference) =>
      `Ik verzoek u het totale bedrag van ${total} te storten op rekening ${iban} op naam van ${holder}, met vermelding van ${reference}.`,
    paymentWithoutReference: (total, iban, holder) =>
      `Ik verzoek u het totale bedrag van ${total} te storten op rekening ${iban} op naam van ${holder}, met vermelding van het adres van het gehuurde goed.`,
    deadline: (date) => `De betaling moet uiterlijk op ${date} op deze rekening staan.`,
    consequence:
      "Als de betaling op die datum niet is ontvangen, zal ik de zaak voorleggen aan de vrederechter en de ontbinding van de huurovereenkomst en de uithuiszetting vorderen, samen met de betaling van de achterstal, de intresten en de kosten.",
    closing: "Hoogachtend,",
  },
  fr: {
    subject: "Recommandé : mise en demeure pour arriérés de loyer",
    reference: (propertyAddress, startDate) =>
      `Concerne : le contrat de bail relatif au bien situé ${propertyAddress}, entré en vigueur le ${startDate}.`,
    salutation: (name) => `Madame, Monsieur ${name},`,
    intro: "Selon ma comptabilité, les loyers suivants sont à ce jour impayés ou partiellement payés :",
    notice: "Par la présente, je vous mets formellement en demeure de payer ces arriérés.",
    headerPeriod: "Période",
    headerDueDate: "Échéance",
    headerAmount: "Montant impayé",
    rentArrears: "Arriérés de loyer",
    credited: "Déjà reçu et imputé",
    otherBalance: "Autre solde de loyer impayé",
    interest: (rate) => `Intérêts de retard (${rate} % par an)`,
    fee: "Indemnité pour paiement tardif",
    total: "Total dû",
    payment: (total, iban, holder, reference) =>
      `Je vous demande de verser le montant total de ${total} sur le compte ${iban} au nom de ${holder}, avec la communication ${reference}.`,
    paymentWithoutReference: (total, iban, holder) =>
      `Je vous demande de verser le montant total de ${total} sur le compte ${iban} au nom de ${holder}, en mentionnant l'adresse du bien loué.`,
    deadline: (date) => `Le paiement doit être parvenu sur ce compte au plus tard le ${date}.`,
    consequence:
      "À défaut de paiement à cette date, je saisirai le juge de paix pour demander la résolution du bail et l'expulsion, ainsi que le paiement des arriérés, des intérêts et des frais.",
    closing: "Veuillez agréer, Madame, Monsieur, mes salutations distinguées.",
  },
  de: {
    subject: "Einschreiben: Inverzugsetzung wegen Mietrückständen",
    reference: (propertyAddress, startDate) =>
      `Betrifft: den Mietvertrag für ${propertyAddress}, in Kraft getreten am ${startDate}.`,
    salutation: (name) => `Sehr geehrte Frau, sehr geehrter Herr ${name},`,
    intro:
      "Nach meinen Unterlagen sind die folgenden Mieten bis heute nicht oder nicht vollständig bezahlt:",
    notice: "Mit diesem Schreiben setze ich Sie förmlich in Verzug mit der Zahlung dieser Rückstände.",
    headerPeriod: "Zeitraum",
    headerDueDate: "Fälligkeit",
    headerAmount: "Offener Betrag",
    rentArrears: "Mietrückstände",
    credited: "Bereits erhalten und verrechnet",
    otherBalance: "Sonstiger offener Mietsaldo",
    interest: (rate) => `Verzugszinsen (${rate} % pro Jahr)`,
    fee: "Entschädigung für verspätete Zahlung",
    total: "Geschuldeter Gesamtbetrag",
    payment: (total, iban, holder, reference) =>
      `Ich fordere Sie auf, den Gesamtbetrag von ${total} auf das Konto ${iban} lautend auf ${holder} zu überweisen, mit der Mitteilung ${reference}.`,
    paymentWithoutReference: (total, iban, holder) =>
      `Ich fordere Sie auf, den Gesamtbetrag von ${total} auf das Konto ${iban} lautend auf ${holder} zu überweisen und dabei die Adresse des Mietobjekts anzugeben.`,
    deadline: (date) => `Die Zahlung muss spätestens am ${date} auf diesem Konto eingegangen sein.`,
    consequence:
      "Geht die Zahlung bis zu diesem Datum nicht ein, werde ich den Friedensrichter anrufen und die Auflösung des Mietvertrags und die Räumung beantragen, zusammen mit der Zahlung der Rückstände, der Zinsen und der Kosten.",
    closing: "Mit freundlichen Grüßen",
  },
  en: {
    subject: "Registered mail: formal notice of default for rent arrears",
    reference: (propertyAddress, startDate) =>
      `Re: the lease for ${propertyAddress}, in force since ${startDate}.`,
    salutation: (name) => `Dear ${name},`,
    intro: "According to my records, the following rent is unpaid or only partly paid as of today:",
    notice: "This letter is a formal notice of default for the payment of these arrears.",
    headerPeriod: "Period",
    headerDueDate: "Due date",
    headerAmount: "Amount outstanding",
    rentArrears: "Rent arrears",
    credited: "Already received and credited",
    otherBalance: "Other outstanding rent balance",
    interest: (rate) => `Late payment interest (${rate} % per year)`,
    fee: "Late payment fee",
    total: "Total due",
    payment: (total, iban, holder, reference) =>
      `Please transfer the total amount of ${total} to account ${iban} in the name of ${holder}, quoting ${reference}.`,
    paymentWithoutReference: (total, iban, holder) =>
      `Please transfer the total amount of ${total} to account ${iban} in the name of ${holder}, quoting the address of the rented property.`,
    deadline: (date) => `The payment must have reached this account by ${date} at the latest.`,
    consequence:
      "If the payment has not been received by that date, I will bring the matter before the justice of the peace and ask for the lease to be dissolved and for eviction, together with payment of the arrears, the interest and the costs.",
    closing: "Yours faithfully,",
  },
};

/** The interest rate as the reader's language writes a decimal. */
function formatRate(rate: number, lang: LetterLanguage): string {
  const text = String(Math.round(rate * 100) / 100);
  return lang === "en" ? text : text.replace(".", ",");
}

function countryCode(country: string): string {
  return (country || "").trim().toUpperCase();
}

/**
 * The envelope block of one party: name, street with the house number the way
 * the letter language writes it, postal code and city. The country is named
 * only when the two parties are in different ones, which is how a Belgian
 * letter is addressed.
 */
function partyLines(party: PostalParty, other: PostalParty, lang: LetterLanguage): string[] {
  const lines = [
    party.name,
    `${party.street} ${formatHouseNumber(party.streetNumber, party.box, lang)}`,
    `${party.postalCode} ${party.city}`,
  ];
  if (countryCode(party.country) !== countryCode(other.country)) {
    lines.push(formatCountry(party.country, lang));
  }
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

function blockText(block: LetterBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "table":
      return [block.columns.map((column) => column.header), ...block.rows]
        .map((row) => row.join(", "))
        .join("\n");
    case "amounts":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    case "signature":
      return `${block.closing}\n\n${block.name}`;
  }
}

/**
 * The letter as plain text. It is stored as the proof of what was sent, so it
 * repeats every section of the drawn document, the postal blocks included.
 */
function renderBody(document: LetterDocument): string {
  const parts = [document.senderLines.join("\n"), document.addresseeLines.join("\n")];
  if (document.placeAndDate !== "") parts.push(document.placeAndDate);
  parts.push(document.subject);
  for (const block of document.blocks) parts.push(blockText(block));
  return parts.filter((part) => part !== "").join("\n\n");
}

/**
 * The formal notice in the tenant's language: the subject, the plain-text
 * letter for the record, the deadline as a calendar date, and the document the
 * PDF renderer draws. The landlord's own locale plays no part.
 */
export function buildFormalNotice(params: FormalNoticeParams): {
  language: LetterLanguage;
  subject: string;
  body: string;
  deadline: string;
  document: LetterDocument;
} {
  const language = letterLanguage(params.tenantLanguage);
  const copy = FORMAL_NOTICE_COPY[language];
  const totals = params.totals;
  const deadline = deadlineDate(params.letterDate, params.deadlineDays);
  const claimed = formatEur(totals.totalClaimed);

  const blocks: LetterBlock[] = [
    {
      kind: "paragraph",
      text: copy.reference(params.propertyAddress, formatShortDate(params.leaseStartDate)),
    },
    { kind: "paragraph", text: copy.salutation(params.addressee.name) },
    { kind: "paragraph", text: copy.intro },
    { kind: "paragraph", text: copy.notice },
  ];

  if (params.rows.length > 0) {
    blocks.push({
      kind: "table",
      columns: [
        { header: copy.headerPeriod, align: "left", widthPercent: 40 },
        { header: copy.headerDueDate, align: "left", widthPercent: 25 },
        { header: copy.headerAmount, align: "right", widthPercent: 35 },
      ],
      rows: params.rows.map((row) => [
        formatMonthYear(row.month, language),
        formatShortDate(row.dueDate),
        formatEur(row.shortfall),
      ]),
    });
  }

  const amounts: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: copy.rentArrears, value: formatEur(totals.rentOwed) },
  ];
  // The months and the contract balance can differ legitimately. One labelled
  // line shows the reader where the difference comes from.
  if (totals.adjustment < -0.005) {
    amounts.push({ label: copy.credited, value: formatEur(Math.abs(totals.adjustment)) });
  } else if (totals.adjustment > 0.005) {
    amounts.push({ label: copy.otherBalance, value: formatEur(totals.adjustment) });
  }
  if (totals.interest > 0) {
    amounts.push({
      label: copy.interest(formatRate(params.annualInterestRate, language)),
      value: formatEur(totals.interest),
    });
  }
  if (totals.fee > 0) {
    amounts.push({ label: copy.fee, value: formatEur(totals.fee) });
  }
  amounts.push({ label: copy.total, value: claimed, bold: true });
  blocks.push({ kind: "amounts", rows: amounts });

  blocks.push({
    kind: "paragraph",
    text: params.structuredCommunication
      ? copy.payment(claimed, params.iban, params.accountHolder, params.structuredCommunication)
      : copy.paymentWithoutReference(claimed, params.iban, params.accountHolder),
  });

  const extra = sanitiseExtraParagraph(params.extraParagraph);
  if (extra) blocks.push({ kind: "paragraph", text: extra });

  blocks.push({ kind: "paragraph", text: copy.deadline(formatShortDate(deadline)) });
  blocks.push({ kind: "paragraph", text: copy.consequence });
  blocks.push({ kind: "signature", closing: copy.closing, name: params.sender.name });

  const document: LetterDocument = {
    language,
    title: copy.subject,
    senderLines: partyLines(params.sender, params.addressee, language),
    addresseeLines: partyLines(params.addressee, params.sender, language),
    placeAndDate: `${params.sender.city}, ${formatLongDate(params.letterDate, language)}`,
    subject: copy.subject,
    blocks,
  };

  return { language, subject: copy.subject, body: renderBody(document), deadline, document };
}
