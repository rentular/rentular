import { describe, it, expect, vi } from "vitest";
import type { LetterLanguage } from "../../lib/belgianFormat";
import {
  FORMAL_NOTICE_COPY,
  FORMAL_NOTICE_DEFAULT_DEADLINE_DAYS,
  buildFormalNotice,
  computeFormalNoticeTotals,
  daysPastDue,
  deadlineDate,
  sanitiseExtraParagraph,
} from "../formalNoticeText";
import {
  arrearsNoticeParams,
  arrearsNoticeRows,
  arrearsRows,
  letterInterest,
  LETTER_DATE,
} from "./fixtures/arrearsLease";

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

function expectInOrder(text: string, parts: string[]) {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    expect(at, `expected "${part}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

const LANGS: LetterLanguage[] = ["nl", "fr", "de", "en"];

/** What each language must say, written out rather than derived from the copy record. */
const SAID: Record<
  LetterLanguage,
  {
    subject: string;
    reference: string;
    salutation: string;
    intro: string;
    notice: string;
    headers: string[];
    firstPeriod: string;
    rentLabel: string;
    creditLabel: string;
    otherLabel: string;
    interestLabel: string;
    feeLabel: string;
    totalLabel: string;
    payment: string;
    paymentNoReferenceTail: string;
    deadline: string;
    consequence: string;
    court: string;
    closing: string;
  }
> = {
  nl: {
    subject: "Aangetekend: ingebrekestelling wegens huurachterstal",
    reference:
      "Betreft: de huurovereenkomst voor Bondgenotenlaan 12 bus 3, 3000 Leuven, in werking getreden op 01/05/2023.",
    salutation: "Geachte Łukasz Wójcik,",
    intro:
      "Volgens mijn administratie zijn de volgende huurbedragen op vandaag niet of niet volledig betaald:",
    notice: "Met deze brief stel ik u formeel in gebreke voor de betaling van deze achterstal.",
    headers: ["Periode", "Vervaldag", "Openstaand bedrag"],
    firstPeriod: "augustus 2026",
    rentLabel: "Achterstallige huur",
    creditLabel: "Reeds ontvangen en verrekend",
    otherLabel: "Overig openstaand huursaldo",
    interestLabel: "Verwijlintresten (3,75 % per jaar)",
    feeLabel: "Vergoeding voor laattijdige betaling",
    totalLabel: "Totaal verschuldigd",
    payment:
      "Ik verzoek u het totale bedrag van € 2.068,77 te storten op rekening BE68 5390 0754 7034 op naam van Marie Peeters, met vermelding van +++123/4567/89002+++.",
    paymentNoReferenceTail:
      "op naam van Marie Peeters, met vermelding van het adres van het gehuurde goed.",
    deadline: "De betaling moet uiterlijk op 04/12/2026 op deze rekening staan.",
    consequence:
      "Als de betaling op die datum niet is ontvangen, zal ik de zaak voorleggen aan de vrederechter en de ontbinding van de huurovereenkomst en de uithuiszetting vorderen, samen met de betaling van de achterstal, de intresten en de kosten.",
    court: "vrederechter",
    closing: "Hoogachtend,",
  },
  fr: {
    subject: "Recommandé : mise en demeure pour arriérés de loyer",
    reference:
      "Concerne : le contrat de bail relatif au bien situé Bondgenotenlaan 12 bus 3, 3000 Leuven, entré en vigueur le 01/05/2023.",
    salutation: "Madame, Monsieur Łukasz Wójcik,",
    intro: "Selon ma comptabilité, les loyers suivants sont à ce jour impayés ou partiellement payés :",
    notice: "Par la présente, je vous mets formellement en demeure de payer ces arriérés.",
    headers: ["Période", "Échéance", "Montant impayé"],
    firstPeriod: "août 2026",
    rentLabel: "Arriérés de loyer",
    creditLabel: "Déjà reçu et imputé",
    otherLabel: "Autre solde de loyer impayé",
    interestLabel: "Intérêts de retard (3,75 % par an)",
    feeLabel: "Indemnité pour paiement tardif",
    totalLabel: "Total dû",
    payment:
      "Je vous demande de verser le montant total de € 2.068,77 sur le compte BE68 5390 0754 7034 au nom de Marie Peeters, avec la communication +++123/4567/89002+++.",
    paymentNoReferenceTail: "au nom de Marie Peeters, en mentionnant l'adresse du bien loué.",
    deadline: "Le paiement doit être parvenu sur ce compte au plus tard le 04/12/2026.",
    consequence:
      "À défaut de paiement à cette date, je saisirai le juge de paix pour demander la résolution du bail et l'expulsion, ainsi que le paiement des arriérés, des intérêts et des frais.",
    court: "juge de paix",
    closing: "Veuillez agréer, Madame, Monsieur, mes salutations distinguées.",
  },
  de: {
    subject: "Einschreiben: Inverzugsetzung wegen Mietrückständen",
    reference:
      "Betrifft: den Mietvertrag für Bondgenotenlaan 12 bus 3, 3000 Leuven, in Kraft getreten am 01/05/2023.",
    salutation: "Sehr geehrte Frau, sehr geehrter Herr Łukasz Wójcik,",
    intro:
      "Nach meinen Unterlagen sind die folgenden Mieten bis heute nicht oder nicht vollständig bezahlt:",
    notice: "Mit diesem Schreiben setze ich Sie förmlich in Verzug mit der Zahlung dieser Rückstände.",
    headers: ["Zeitraum", "Fälligkeit", "Offener Betrag"],
    firstPeriod: "August 2026",
    rentLabel: "Mietrückstände",
    creditLabel: "Bereits erhalten und verrechnet",
    otherLabel: "Sonstiger offener Mietsaldo",
    interestLabel: "Verzugszinsen (3,75 % pro Jahr)",
    feeLabel: "Entschädigung für verspätete Zahlung",
    totalLabel: "Geschuldeter Gesamtbetrag",
    payment:
      "Ich fordere Sie auf, den Gesamtbetrag von € 2.068,77 auf das Konto BE68 5390 0754 7034 lautend auf Marie Peeters zu überweisen, mit der Mitteilung +++123/4567/89002+++.",
    paymentNoReferenceTail: "zu überweisen und dabei die Adresse des Mietobjekts anzugeben.",
    deadline: "Die Zahlung muss spätestens am 04/12/2026 auf diesem Konto eingegangen sein.",
    consequence:
      "Geht die Zahlung bis zu diesem Datum nicht ein, werde ich den Friedensrichter anrufen und die Auflösung des Mietvertrags und die Räumung beantragen, zusammen mit der Zahlung der Rückstände, der Zinsen und der Kosten.",
    court: "Friedensrichter",
    closing: "Mit freundlichen Grüßen",
  },
  en: {
    subject: "Registered mail: formal notice of default for rent arrears",
    reference: "Re: the lease for Bondgenotenlaan 12 bus 3, 3000 Leuven, in force since 01/05/2023.",
    salutation: "Dear Łukasz Wójcik,",
    intro: "According to my records, the following rent is unpaid or only partly paid as of today:",
    notice: "This letter is a formal notice of default for the payment of these arrears.",
    headers: ["Period", "Due date", "Amount outstanding"],
    firstPeriod: "August 2026",
    rentLabel: "Rent arrears",
    creditLabel: "Already received and credited",
    otherLabel: "Other outstanding rent balance",
    interestLabel: "Late payment interest (3.75 % per year)",
    feeLabel: "Late payment fee",
    totalLabel: "Total due",
    payment:
      "Please transfer the total amount of € 2.068,77 to account BE68 5390 0754 7034 in the name of Marie Peeters, quoting +++123/4567/89002+++.",
    paymentNoReferenceTail: "in the name of Marie Peeters, quoting the address of the rented property.",
    deadline: "The payment must have reached this account by 04/12/2026 at the latest.",
    consequence:
      "If the payment has not been received by that date, I will bring the matter before the justice of the peace and ask for the lease to be dissolved and for eviction, together with payment of the arrears, the interest and the costs.",
    court: "justice of the peace",
    closing: "Yours faithfully,",
  },
};

/** The place and date line as each language writes 18 November 2026 in Leuven. */
const PLACE_AND_DATE: Record<LetterLanguage, string> = {
  nl: "Leuven, 18 november 2026",
  fr: "Leuven, 18 novembre 2026",
  de: "Leuven, 18. November 2026",
  en: "Leuven, 18 November 2026",
};

/** The same letter with every conditional line switched on and off. */
function everyBranch(lang: LetterLanguage) {
  const base = { tenantLanguage: lang as string };
  return [
    buildFormalNotice(arrearsNoticeParams(base)),
    buildFormalNotice(
      arrearsNoticeParams({
        ...base,
        extraParagraph: "Graag een reactie binnen de week.",
        structuredCommunication: null,
        totals: {
          tableSum: 2037.35,
          rentOwed: 1837.35,
          adjustment: -200,
          interest: 0,
          fee: 0,
          totalClaimed: 1837.35,
        },
      }),
    ),
    buildFormalNotice(
      arrearsNoticeParams({
        ...base,
        rows: [],
        totals: { tableSum: 0, rentOwed: 812.45, adjustment: 812.45, interest: 2.5, fee: 15, totalClaimed: 829.95 },
      }),
    ),
    buildFormalNotice(arrearsNoticeParams({ ...base, rows: arrearsRows(12) })),
  ];
}

describe.each(LANGS)("buildFormalNotice (%s)", (lang) => {
  const said = SAID[lang];

  it("says what a formal notice has to say, in order", () => {
    const notice = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));

    expect(notice.language).toBe(lang);
    expect(notice.subject).toBe(said.subject);
    expect(notice.deadline).toBe("2026-12-04");

    expectInOrder(notice.body, [
      "Marie Peeters",
      "Łukasz Wójcik",
      PLACE_AND_DATE[lang],
      said.subject,
      said.reference,
      said.salutation,
      said.intro,
      said.notice,
      said.firstPeriod,
      said.totalLabel,
      "BE68 5390 0754 7034",
      "04/12/2026",
      said.consequence,
      said.closing,
      "Marie Peeters",
    ]);
    expect(notice.body).toContain(said.court);
    for (const header of said.headers) expect(notice.body).toContain(header);
  });

  it("drops interest and the fee when the contract does not carry them", () => {
    const both = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));
    expect(both.body).toContain(said.interestLabel);
    expect(both.body).toContain(said.feeLabel);
    expect(both.body.indexOf(said.interestLabel)).toBeLessThan(both.body.indexOf(said.feeLabel));

    const none = buildFormalNotice(
      arrearsNoticeParams({
        tenantLanguage: lang,
        totals: {
          tableSum: 2037.35,
          rentOwed: 2037.35,
          adjustment: 0,
          interest: 0,
          fee: 0,
          totalClaimed: 2037.35,
        },
      }),
    );
    expect(none.body).not.toContain(said.interestLabel);
    expect(none.body).not.toContain(said.feeLabel);
    expect(none.body).toContain(said.rentLabel);
    expect(none.body).toContain(said.totalLabel);
  });

  it("reconciles the table against the contract balance, and stays quiet when they agree", () => {
    const credited = buildFormalNotice(
      arrearsNoticeParams({
        tenantLanguage: lang,
        totals: {
          tableSum: 2037.35,
          rentOwed: 1837.35,
          adjustment: -200,
          interest: 16.42,
          fee: 15,
          totalClaimed: 1868.77,
        },
      }),
    );
    expect(credited.body).toContain(said.creditLabel);
    expect(credited.body).toContain("200,00");
    expect(credited.body).not.toContain(said.otherLabel);

    const other = buildFormalNotice(
      arrearsNoticeParams({
        tenantLanguage: lang,
        totals: {
          tableSum: 2037.35,
          rentOwed: 2087.35,
          adjustment: 50,
          interest: 16.42,
          fee: 15,
          totalClaimed: 2118.77,
        },
      }),
    );
    expect(other.body).toContain(said.otherLabel);
    expect(other.body).not.toContain(said.creditLabel);

    const even = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));
    expect(even.body).not.toContain(said.creditLabel);
    expect(even.body).not.toContain(said.otherLabel);
  });

  it("asks for the money with the structured reference, or without one", () => {
    const withRef = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));
    expect(withRef.body).toContain(said.payment);

    const without = buildFormalNotice(
      arrearsNoticeParams({ tenantLanguage: lang, structuredCommunication: null }),
    );
    expect(without.body).not.toContain("+++");
    expect(without.body).toContain(said.paymentNoReferenceTail);
  });

  it("puts the landlord's own paragraph after the payment instruction, or nothing at all", () => {
    const extra = "Ik ben bereid een afbetalingsplan te bespreken.";
    const withExtra = buildFormalNotice(
      arrearsNoticeParams({ tenantLanguage: lang, extraParagraph: extra }),
    );

    expectInOrder(withExtra.body, [said.payment, extra, said.deadline]);

    const withoutExtra = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));
    expect(withoutExtra.body).not.toContain(extra);
    expect(withoutExtra.body).not.toMatch(/\n{3,}/);
  });

  it("counts the deadline from the letter date and prints it as a calendar date", () => {
    const sixteen = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang }));
    expect(sixteen.deadline).toBe("2026-12-04");
    expect(sixteen.body).toContain(said.deadline);

    const thirty = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: lang, deadlineDays: 30 }));
    expect(thirty.deadline).toBe("2026-12-18");
    expect(thirty.body).toContain("18/12/2026");
  });

  it("leaves the table out when the debt sits in no open month", () => {
    const notice = buildFormalNotice(
      arrearsNoticeParams({
        tenantLanguage: lang,
        rows: [],
        totals: { tableSum: 0, rentOwed: 500, adjustment: 500, interest: 0, fee: 0, totalClaimed: 500 },
      }),
    );
    expect(notice.document.blocks.some((b) => b.kind === "table")).toBe(false);
    expect(notice.body).toContain(said.rentLabel);
    expect(notice.body).toContain(said.totalLabel);
    expect(notice.body).toContain("€ 500,00");
  });

  it("cites no statute and threatens nothing beyond the court case", () => {
    // The word boundary matters: "maart 2026" is the Dutch month, not a
    // citation, and ends in the same three letters as "art".
    const citation = /\bart(icle|ikel)?\.?\s*\d/i;
    const citationWord = /\b(art|arts|artikel|artikelen|article|articles)\b/i;
    for (const notice of everyBranch(lang)) {
      expect(notice.body).not.toMatch(citation);
      expect(JSON.stringify(notice.document)).not.toMatch(citation);
      expect(notice.body).not.toMatch(citationWord);
      for (const book of ["Book 5", "Boek 5", "Livre 5", "Buch 5"]) {
        expect(notice.body).not.toContain(book);
      }
    }
  });

  it("writes no em-dash and no en-dash", () => {
    for (const notice of everyBranch(lang)) {
      expect(notice.body).not.toMatch(/[–—]/);
      expect(JSON.stringify(notice.document)).not.toMatch(/[–—]/);
    }
  });
});

describe("buildFormalNotice (language selection)", () => {
  it("follows the tenant's language, not the landlord's", () => {
    const notice = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: "fr" }));
    expect(notice.language).toBe("fr");
    expect(notice.subject).toBe(SAID.fr.subject);
  });

  it("falls back to English for a language we have no letter for", () => {
    const notice = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: "es" }));
    expect(notice.language).toBe("en");
    expect(notice.subject).toBe(SAID.en.subject);
  });

  it("has every sentence in all four languages", () => {
    for (const lang of LANGS) expect(FORMAL_NOTICE_COPY[lang].subject).toBe(SAID[lang].subject);
    expect(Object.keys(FORMAL_NOTICE_COPY).sort()).toEqual(["de", "en", "fr", "nl"]);
  });
});

describe("buildFormalNotice (document structure)", () => {
  it("holds the sections in the order the letter prints them", () => {
    const withExtra = buildFormalNotice(
      arrearsNoticeParams({ extraParagraph: "Ik ben bereid een afbetalingsplan te bespreken." }),
    );
    expect(withExtra.document.blocks.map((b) => b.kind)).toEqual([
      "paragraph", // contract reference
      "paragraph", // salutation
      "paragraph", // intro
      "paragraph", // the notice sentence
      "table",
      "amounts",
      "paragraph", // payment instruction
      "paragraph", // the landlord's own paragraph
      "paragraph", // deadline
      "paragraph", // consequence
      "signature",
    ]);

    const without = buildFormalNotice(arrearsNoticeParams());
    expect(without.document.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "table",
      "amounts",
      "paragraph",
      "paragraph",
      "paragraph",
      "signature",
    ]);
  });

  it("describes the arrears table and the amounts for the renderer", () => {
    const { document } = buildFormalNotice(arrearsNoticeParams());

    const table = document.blocks.find((b) => b.kind === "table");
    if (table?.kind !== "table") throw new Error("no table block");
    expect(table.columns).toHaveLength(3);
    expect(table.columns.map((c) => c.header)).toEqual(SAID.nl.headers);
    expect(table.columns[2]!.align).toBe("right");
    expect(table.columns.reduce((sum, c) => sum + c.widthPercent, 0)).toBe(100);
    expect(table.rows).toEqual([
      ["augustus 2026", "01/08/2026", "€ 812,45"],
      ["september 2026", "01/09/2026", "€ 412,45"],
      ["oktober 2026", "01/10/2026", "€ 812,45"],
    ]);

    const amounts = document.blocks.find((b) => b.kind === "amounts");
    if (amounts?.kind !== "amounts") throw new Error("no amounts block");
    expect(amounts.rows).toEqual([
      { label: "Achterstallige huur", value: "€ 2.037,35" },
      { label: "Verwijlintresten (3,75 % per jaar)", value: "€ 16,42" },
      { label: "Vergoeding voor laattijdige betaling", value: "€ 15,00" },
      { label: "Totaal verschuldigd", value: "€ 2.068,77", bold: true },
    ]);

    const signature = document.blocks.at(-1);
    if (signature?.kind !== "signature") throw new Error("no signature block");
    expect(signature).toEqual({ kind: "signature", closing: "Hoogachtend,", name: "Marie Peeters" });

    expect(document.title).toBe(SAID.nl.subject);
    expect(document.placeAndDate).toBe(PLACE_AND_DATE.nl);
    expect(document.subject).toBe(SAID.nl.subject);
  });

  it("writes both envelope blocks and adds a country only when the two differ", () => {
    const home = buildFormalNotice(arrearsNoticeParams()).document;
    expect(home.senderLines).toEqual(["Marie Peeters", "Tervuursestraat 97", "3000 Leuven"]);
    expect(home.addresseeLines).toEqual(["Łukasz Wójcik", "Bondgenotenlaan 12 bus 3", "3000 Leuven"]);

    const abroad = buildFormalNotice(
      arrearsNoticeParams({
        addressee: {
          name: "Łukasz Wójcik",
          street: "Rue Neuve",
          streetNumber: "4",
          box: null,
          postalCode: "75001",
          city: "Paris",
          country: "FR",
        },
      }),
    ).document;
    expect(abroad.senderLines).toEqual(["Marie Peeters", "Tervuursestraat 97", "3000 Leuven", "België"]);
    expect(abroad.addresseeLines).toEqual(["Łukasz Wójcik", "Rue Neuve 4", "75001 Paris", "Frankrijk"]);

    const french = buildFormalNotice(arrearsNoticeParams({ tenantLanguage: "fr" })).document;
    expect(french.addresseeLines[1]).toBe("Bondgenotenlaan 12 boîte 3");
  });
});
