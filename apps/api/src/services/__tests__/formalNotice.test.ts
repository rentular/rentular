/**
 * generateFormalNotice against a mocked database.
 *
 * The letter text, the money arithmetic and the PDF renderer are the real
 * ones: this test only replaces the database, the clock, the interest formula
 * (services/paymentFollowUp.ts starts the e-mail queue worker on import) and
 * the communications logger. So every PDF asserted here is a real pdfkit
 * render of the real copy.
 *
 * The database mock answers selects from a FIFO queue, so the order of the
 * reads in the service is part of the contract this test pins:
 * lease, property, owner, liable tenants, bank account, follow-up settings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { arrearsPerMonth, LETTER_DATE, MONTHLY_RENT } from "./fixtures/arrearsLease";

const loadContractBalance = vi.fn();
vi.mock("../contractBalance", () => ({
  loadContractBalance: (...args: unknown[]) => loadContractBalance(...args),
}));

vi.mock("../paymentFollowUp", () => ({
  // Same formula as the real module, without its database and queue imports.
  calculateInterest: (amount: number, days: number, annualRate: number) =>
    Math.round(amount * (annualRate / 100 / 365) * days * 100) / 100,
  DEFAULT_SETTINGS: { interestEnabled: false, annualInterestRate: 3.75 },
}));

const logged: Array<Record<string, any>> = [];
const logCommunication = vi.fn(async (input: Record<string, any>) => {
  logged.push(input);
  return `comm-${logged.length}`;
});
vi.mock("../../lib/communicationLog", () => ({
  logCommunication: (input: Record<string, any>) => logCommunication(input),
}));

vi.mock("../../lib/timezone", () => ({
  todayInZone: () => LETTER_DATE,
  getScheduleTimezone: () => "Europe/Brussels",
}));

// The real renderer, wrapped so the test can count its calls: a refusal must
// not draw anything.
const renderSpy = vi.fn();
vi.mock("../../lib/pdfLetter", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    renderLetterPdf: (...args: unknown[]) => {
      renderSpy(...args);
      return actual.renderLetterPdf(...args);
    },
  };
});

let reads: unknown[][] = [];

function selectChain(): any {
  const target: any = function () {};
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = Promise.resolve(reads.length ? reads.shift() : []);
        return r.then.bind(r);
      }
      if (prop === "catch" || prop === "finally") {
        const r = Promise.resolve(reads.length ? reads.shift() : []);
        return (r as any)[prop].bind(r);
      }
      return () => selectChain();
    },
  });
}

vi.mock("@rentular/db", () => ({
  getDb: vi.fn(() => ({ select: () => selectChain() })),
  leases: {}, properties: {}, users: {}, tenants: {}, leaseTenants: {},
  bankAccounts: {}, paymentFollowUpSettings: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => ({ eq: a })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
}));

const LEASE = {
  id: "lease-1",
  propertyId: "prop-1",
  ownerId: "owner-A",
  startDate: "2023-05-01",
  endDate: null,
  structuredCommunication: "+++123/4567/89002+++",
  bankAccountId: "bank-1",
  latePaymentFeeEnabled: true,
  latePaymentFeeAmount: "15.00",
  monthlyRent: String(MONTHLY_RENT),
  monthlyCharges: "0.00",
  paymentDay: 1,
};

const PROPERTY = {
  street: "Bondgenotenlaan",
  streetNumber: "12",
  box: "3",
  postalCode: "3000",
  city: "Leuven",
  country: "BE",
};

const OWNER = {
  name: "Marie Peeters",
  street: "Tervuursestraat",
  streetNumber: "97",
  box: null,
  postalCode: "3000",
  city: "Leuven",
  country: "BE",
};

const NO_CORRESPONDENCE = {
  correspondenceStreet: null,
  correspondenceStreetNumber: null,
  correspondenceBox: null,
  correspondencePostalCode: null,
  correspondenceCity: null,
  correspondenceCountry: null,
};

const PRIMARY = {
  id: "t-1",
  firstName: "Łukasz",
  lastName: "Wójcik",
  language: "nl",
  isPrimary: true,
  ...NO_CORRESPONDENCE,
};

const CO_TENANT = {
  id: "t-2",
  firstName: "Ayşegül",
  lastName: "Yılmaz",
  language: "fr",
  isPrimary: false,
  ...NO_CORRESPONDENCE,
};

const BANK = { iban: "BE68 5390 0754 7034", holderName: "Marie Peeters" };
const SETTINGS = { interestEnabled: true, annualInterestRate: "3.75" };

function balance(overrides: Record<string, unknown> = {}) {
  return {
    expected: 4062.25,
    received: 2024.9,
    arrearsRepaid: 0,
    paidInAdvance: 0,
    owed: 2037.35,
    credit: 0,
    fromMonth: "2026-06",
    perMonth: arrearsPerMonth(),
    ...overrides,
  };
}

/** The six reads in the order the service makes them. */
function fullReads(
  opts: {
    lease?: Record<string, unknown> | null;
    property?: Record<string, unknown>;
    owner?: Record<string, unknown> | null;
    tenantRows?: Array<Record<string, unknown>>;
    bank?: Record<string, unknown> | null;
    settings?: Record<string, unknown> | null;
  } = {},
): unknown[][] {
  return [
    opts.lease === null ? [] : [opts.lease ?? LEASE],
    [opts.property ?? PROPERTY],
    opts.owner === null ? [] : [opts.owner ?? OWNER],
    opts.tenantRows ?? [PRIMARY],
    opts.bank === null ? [] : [opts.bank ?? BANK],
    opts.settings === null ? [] : [opts.settings ?? SETTINGS],
  ];
}

async function run(input: Record<string, unknown> = {}) {
  const { generateFormalNotice }: any = await import("../formalNotice");
  return generateFormalNotice({ leaseId: "lease-1", ...input });
}

function pdfBytes(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

beforeEach(() => {
  vi.resetModules();
  reads = [];
  logged.length = 0;
  logCommunication.mockClear();
  renderSpy.mockClear();
  loadContractBalance.mockReset().mockResolvedValue(balance());
});

describe("generateFormalNotice: which months the letter claims (D-22)", () => {
  it("claims every open month, oldest first, and leaves settled and ignored months out", async () => {
    reads = fullReads();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.arrears).toEqual([
      { month: "2026-08", dueDate: "2026-08-01", shortfall: 812.45 },
      { month: "2026-09", dueDate: "2026-09-01", shortfall: 412.45 },
      { month: "2026-10", dueDate: "2026-10-01", shortfall: 812.45 },
    ]);
  });

  it("asks the balance for the contract on today in the scheduling timezone", async () => {
    reads = fullReads();
    await run();
    expect(loadContractBalance).toHaveBeenCalledWith(expect.anything(), LEASE, LETTER_DATE);
  });
});

describe("generateFormalNotice: the money (D-23, D-32, D-33)", () => {
  it("claims the contract balance, the per-month interest and the lease fee", async () => {
    reads = fullReads();
    const result = await run();
    expect(result.totals).toEqual({
      tableSum: 2037.35,
      rentOwed: 2037.35,
      adjustment: 0,
      interest: 16.42,
      fee: 15,
      totalClaimed: 2068.77,
    });
  });

  it("charges no interest when the owner has it switched off", async () => {
    reads = fullReads({ settings: { interestEnabled: false, annualInterestRate: "3.75" } });
    const result = await run();
    expect(result.totals.interest).toBe(0);
    expect(result.totals.totalClaimed).toBe(2052.35);
  });

  it("falls back to the follow-up defaults when the owner has no settings row", async () => {
    reads = fullReads({ settings: null });
    const result = await run();
    expect(result.totals.interest).toBe(0);
  });

  it("records that the interest flag came from the owner setting", async () => {
    reads = fullReads();
    await run();
    expect(logged[0]!.metadata.interestSource).toBe("owner_setting");
  });

  it("charges no fee when the lease has it switched off", async () => {
    reads = fullReads({ lease: { ...LEASE, latePaymentFeeEnabled: false } });
    const result = await run();
    expect(result.totals.fee).toBe(0);
    expect(result.totals.totalClaimed).toBe(2053.77);
  });

  it("takes the rent claimed from the balance, not from the table", async () => {
    loadContractBalance.mockResolvedValue(balance({ owed: 1900 }));
    reads = fullReads();
    const result = await run();
    expect(result.totals.rentOwed).toBe(1900);
    expect(result.totals.tableSum).toBe(2037.35);
    expect(result.totals.adjustment).toBe(-137.35);
  });
});

describe("generateFormalNotice: one letter per liable tenant (D-35)", () => {
  it("returns a letter per tenant, primary first, each a real PDF and its own log row", async () => {
    reads = fullReads({ tenantRows: [CO_TENANT, PRIMARY] });
    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.letters).toHaveLength(2);
    expect(result.letters.map((l: any) => l.recipientName)).toEqual([
      "Łukasz Wójcik",
      "Ayşegül Yılmaz",
    ]);
    expect(result.letters.map((l: any) => l.tenantId)).toEqual(["t-1", "t-2"]);
    for (const letter of result.letters) {
      expect(pdfBytes(letter.pdfBase64).subarray(0, 4).toString("latin1")).toBe("%PDF");
    }
    expect(result.letters[0].filename).toBe(`ingebrekestelling-lease-1-${LETTER_DATE}-1.pdf`);
    expect(result.letters[1].filename).toBe(`ingebrekestelling-lease-1-${LETTER_DATE}-2.pdf`);
    expect(result.letters.map((l: any) => l.communicationId)).toEqual(["comm-1", "comm-2"]);
    expect(logCommunication).toHaveBeenCalledTimes(2);
  });

  it("writes each letter in its own tenant's language (D-25)", async () => {
    reads = fullReads({ tenantRows: [PRIMARY, CO_TENANT] });
    const result = await run();
    expect(result.letters[0].language).toBe("nl");
    expect(result.letters[1].language).toBe("fr");
    expect(logged[0]!.subject).toBe("Aangetekend: ingebrekestelling wegens huurachterstal");
    expect(logged[1]!.subject).toBe("Recommandé : mise en demeure pour arriérés de loyer");
  });

  it("keeps the letter when the log row could not be written", async () => {
    logCommunication.mockResolvedValueOnce(null as never);
    reads = fullReads();
    const result = await run();
    expect(result.letters[0].communicationId).toBeNull();
    expect(result.letters[0].pdfBase64.length).toBeGreaterThan(0);
  });
});

describe("generateFormalNotice: where the letter is sent (D-13)", () => {
  it("addresses the rented property when the tenant has no correspondence address", async () => {
    reads = fullReads();
    const result = await run();
    expect(result.letters[0].addressSource).toBe("property");
    expect(logged[0]!.metadata.addresseeLines).toEqual([
      "Łukasz Wójcik",
      "Bondgenotenlaan 12 bus 3",
      "3000 Leuven",
    ]);
  });

  it("addresses the correspondence address when it is filled in", async () => {
    reads = fullReads({
      tenantRows: [
        {
          ...PRIMARY,
          correspondenceStreet: "Gevangenisstraat",
          correspondenceStreetNumber: "1",
          correspondenceBox: null,
          correspondencePostalCode: "9000",
          correspondenceCity: "Gent",
          correspondenceCountry: null,
        },
      ],
    });
    const result = await run();
    expect(result.letters[0].addressSource).toBe("correspondence");
    expect(logged[0]!.metadata.addresseeLines).toEqual([
      "Łukasz Wójcik",
      "Gevangenisstraat 1",
      "9000 Gent",
    ]);
  });

  it("ignores a correspondence address without a city", async () => {
    reads = fullReads({
      tenantRows: [
        {
          ...PRIMARY,
          correspondenceStreet: "Gevangenisstraat",
          correspondencePostalCode: "9000",
          correspondenceCity: "   ",
        },
      ],
    });
    const result = await run();
    expect(result.letters[0].addressSource).toBe("property");
  });
});

describe("generateFormalNotice: the proof it leaves behind (D-19)", () => {
  it("logs a queued letter of type formal_notice with the whole claim in its metadata", async () => {
    reads = fullReads();
    await run({ deadlineDays: 20, trigger: { trigger: "api", triggeredBy: "user-A" } });
    const row = logged[0]!;
    expect(row.ownerId).toBe("owner-A");
    expect(row.leaseId).toBe("lease-1");
    expect(row.channel).toBe("letter");
    expect(row.type).toBe("formal_notice");
    expect(row.recipientName).toBe("Łukasz Wójcik");
    expect(row.subject).toBe("Aangetekend: ingebrekestelling wegens huurachterstal");
    expect(row.body).toContain("Totaal verschuldigd");
    expect(row.body).toContain("€ 2.068,77");
    expect(row.metadata).toMatchObject({
      trigger: "api",
      triggeredBy: "user-A",
      tenantId: "t-1",
      language: "nl",
      addressSource: "property",
      filename: `ingebrekestelling-lease-1-${LETTER_DATE}-1.pdf`,
      letterDate: LETTER_DATE,
      deadline: "2026-12-08",
      deadlineDays: 20,
      rentOwed: 2037.35,
      tableSum: 2037.35,
      adjustment: 0,
      interest: 16.42,
      fee: 15,
      totalClaimed: 2068.77,
      interestSource: "owner_setting",
    });
    expect(row.metadata.arrears).toEqual([
      { month: "2026-08", dueDate: "2026-08-01", shortfall: 812.45 },
      { month: "2026-09", dueDate: "2026-09-01", shortfall: 412.45 },
      { month: "2026-10", dueDate: "2026-10-01", shortfall: 812.45 },
    ]);
  });

  it("marks a letter a person asked for as manually triggered", async () => {
    reads = fullReads();
    await run({ trigger: { trigger: "manual", triggeredBy: "user-A" } });
    expect(logged[0]!.metadata.trigger).toBe("manual");
  });
});

describe("generateFormalNotice: the deadline", () => {
  it("gives the tenant sixteen days by default", async () => {
    reads = fullReads();
    const result = await run();
    expect(result.deadlineDays).toBe(16);
    expect(result.deadline).toBe("2026-12-04");
  });

  it("honours a deadline the landlord chose", async () => {
    reads = fullReads();
    const result = await run({ deadlineDays: 30 });
    expect(result.deadline).toBe("2026-12-18");
  });
});

describe("generateFormalNotice: the landlord's own paragraph", () => {
  it("passes it through the sanitiser before it reaches the letter", async () => {
    reads = fullReads();
    const result = await run({
      extraParagraph: "Ik heb u \u0007al twee keer gebeld.\n\n\n\nGraag een reactie.",
    });
    expect(result.ok).toBe(true);
    expect(logged[0]!.body).toContain("Ik heb u al twee keer gebeld.\n\nGraag een reactie.");
  });
});

describe("generateFormalNotice: refusals", () => {
  it("refuses a landlord without a postal address and names Settings (D-14)", async () => {
    reads = fullReads({ owner: { ...OWNER, street: null, postalCode: null, city: null } });
    const result = await run();
    expect(result).toEqual({
      ok: false,
      code: "missing_sender_address",
      error: expect.stringContaining("Settings"),
    });
    expect(renderSpy).not.toHaveBeenCalled();
    expect(logCommunication).not.toHaveBeenCalled();
  });

  it("still writes the letter when only the house number is missing", async () => {
    reads = fullReads({ owner: { ...OWNER, streetNumber: null } });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(logged[0]!.body).toContain("Tervuursestraat");
    expect(logged[0]!.body).not.toMatch(/null/);
    expect(logged[0]!.body).not.toMatch(/undefined/);
  });

  it("refuses an unknown contract", async () => {
    reads = fullReads({ lease: null });
    expect((await run()).code).toBe("lease_not_found");
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("refuses a contract without tenants", async () => {
    reads = fullReads({ tenantRows: [] });
    expect((await run()).code).toBe("no_tenant");
    expect(logCommunication).not.toHaveBeenCalled();
  });

  it("refuses a contract without a linked bank account", async () => {
    reads = fullReads({ bank: null });
    expect((await run()).code).toBe("missing_bank_account");
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("refuses a contract whose bank account was never chosen", async () => {
    reads = fullReads({ lease: { ...LEASE, bankAccountId: null } });
    expect((await run()).code).toBe("missing_bank_account");
  });

  it("refuses an even contract", async () => {
    loadContractBalance.mockResolvedValue(balance({ owed: 0, perMonth: [] }));
    reads = fullReads();
    expect((await run()).code).toBe("nothing_owed");
    expect(renderSpy).not.toHaveBeenCalled();
    expect(logCommunication).not.toHaveBeenCalled();
  });

  it("refuses a contract in credit", async () => {
    loadContractBalance.mockResolvedValue(balance({ owed: 0, credit: 120 }));
    reads = fullReads();
    expect((await run()).code).toBe("nothing_owed");
  });

  it("refuses a contract with no balance at all", async () => {
    loadContractBalance.mockResolvedValue(null);
    reads = fullReads();
    expect((await run()).code).toBe("nothing_owed");
  });
});

describe("generateFormalNotice: what it writes to the log (T-11.2-23)", () => {
  it("never puts the letter, a tenant name or an address in stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reads = fullReads({ tenantRows: [PRIMARY, CO_TENANT] });
    const result = await run();
    expect(result.ok).toBe(true);

    const written = [...log.mock.calls, ...error.mock.calls]
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");
    expect(written).not.toContain("Wójcik");
    expect(written).not.toContain("Yılmaz");
    expect(written).not.toContain("Bondgenotenlaan");
    expect(written).not.toContain("Totaal verschuldigd");
    expect(written).toContain("lease-1");
    log.mockRestore();
    error.mockRestore();
  });
});
