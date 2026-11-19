/**
 * The letter renderer, checked on the things that are invisible in a happy
 * local run: the page really is A4, the font really is embedded, a name
 * outside Latin-1 really survives into the extractable text, and the font
 * path really resolves from the module's own location.
 *
 * Page dictionaries are counted on the uncompressed bytes: with compression
 * on, /Type /Page lives inside a flate stream and cannot be matched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LetterDocument } from "../letterDocument";
import { normaliseLetterText, renderLetterPdf, resolveFontDir } from "../pdfLetter";
import { arrearsNoticeParams, arrearsRows, letterInterest } from "../../services/__tests__/fixtures/arrearsLease";
import {
  buildFormalNotice,
  computeFormalNoticeTotals,
  type FormalNoticeArrearsRow,
  type FormalNoticeParams,
} from "../../services/formalNoticeText";

function noticeDocument(overrides: Partial<FormalNoticeParams> = {}): LetterDocument {
  return buildFormalNotice(arrearsNoticeParams(overrides)).document;
}

/** The totals a letter over these months claims, with the fixture's rate. */
function totalsFor(rows: FormalNoticeArrearsRow[]): FormalNoticeParams["totals"] {
  const rentOwed = rows.reduce((sum, row) => sum + row.shortfall, 0);
  return computeFormalNoticeTotals(
    {
      rows,
      rentOwed,
      interestEnabled: true,
      annualInterestRate: 3.75,
      feeEnabled: true,
      feeAmount: 15,
    },
    letterInterest,
  );
}

async function renderPlain(document: LetterDocument): Promise<{ bytes: Buffer; raw: string }> {
  const bytes = await renderLetterPdf(document, { compress: false });
  return { bytes, raw: bytes.toString("latin1") };
}

function countPages(raw: string): number {
  return (raw.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

function hasPdftotext(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractText(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "pdfletter-"));
  const file = join(dir, "letter.pdf");
  writeFileSync(file, bytes);
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8" });
}

describe("renderLetterPdf", () => {
  it("produces real PDF bytes", async () => {
    const bytes = await renderLetterPdf(noticeDocument());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it("draws on A4, 595.28 by 841.89 points", async () => {
    const { raw } = await renderPlain(noticeDocument());
    expect(raw).toContain("/MediaBox [0 0 595.28 841.89]");
  });

  it("fits the three-month notice on one page", async () => {
    const { raw } = await renderPlain(noticeDocument());
    expect(countPages(raw)).toBe(1);
  });

  it("breaks a sixty-month table across pages and stays a valid PDF", async () => {
    const rows = arrearsRows(60);
    const document = noticeDocument({ rows, totals: totalsFor(rows) });
    const { bytes, raw } = await renderPlain(document);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(countPages(raw)).toBeGreaterThanOrEqual(2);
  });

  it("embeds a font program and never falls back to the built-in Helvetica", async () => {
    const { raw } = await renderPlain(noticeDocument());
    expect(raw).toContain("FontFile2");
    expect(raw).not.toContain("/BaseFont /Helvetica");
  });

  it.each(["nl", "fr", "de", "en"] as const)("renders the %s letter", async (language) => {
    const document = noticeDocument({ tenantLanguage: language });
    const bytes = await renderLetterPdf(document);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it("carries the French and German accents into the drawn copy", async () => {
    const fr = noticeDocument({ tenantLanguage: "fr" });
    const de = noticeDocument({ tenantLanguage: "de" });
    // The accented words have to be in the copy, otherwise the renders above
    // prove nothing about accents.
    expect(JSON.stringify(fr.blocks)).toContain("arriérés");
    expect(JSON.stringify(de.blocks)).toContain("Mietrückstände");
    for (const document of [fr, de]) {
      const bytes = await renderLetterPdf(document);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  describe("names outside Latin-1", () => {
    const document: LetterDocument = {
      ...noticeDocument(),
      addresseeLines: [
        "Łukasz Wójcik",
        "Ayşegül Yılmaz",
        "Ștefan Ionescu",
        "Dvořák",
        "Иванов",
        "arriérés",
        "Mietrückstände",
        "€ 1.150,00",
      ],
    };

    it("renders without throwing", async () => {
      const bytes = await renderLetterPdf(document);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    it.skipIf(!hasPdftotext())("keeps the glyphs extractable", async () => {
      const bytes = await renderLetterPdf(document);
      const text = extractText(bytes);
      expect(text).toContain("Łukasz Wójcik");
      expect(text).toContain("Ayşegül");
      expect(text).toContain("Иванов");
    });
  });

  it("renders the late-payment overview shape: no date line, no signature", async () => {
    const base = noticeDocument();
    const document: LetterDocument = {
      ...base,
      placeAndDate: "",
      blocks: base.blocks.filter((block) => block.kind !== "signature"),
    };
    const bytes = await renderLetterPdf(document);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("normaliseLetterText", () => {
  it("precomposes a decomposed accent", () => {
    const decomposed = "Angèle";
    expect(decomposed.length).toBe(7);
    const normalised = normaliseLetterText(decomposed);
    expect(normalised).toBe("Angèle");
    expect(normalised.length).toBe(6);
  });

  it("leaves an already precomposed string alone", () => {
    expect(normaliseLetterText("Angèle")).toBe("Angèle");
  });
});

describe("resolveFontDir", () => {
  it("finds the committed fonts from the module's own location", () => {
    const dir = resolveFontDir();
    expect(existsSync(join(dir, "LiberationSans-Regular.ttf"))).toBe(true);
    expect(existsSync(join(dir, "LiberationSans-Bold.ttf"))).toBe(true);
  });

  it("ignores a FORMAL_NOTICE_FONT_DIR that does not exist", () => {
    const before = process.env.FORMAL_NOTICE_FONT_DIR;
    process.env.FORMAL_NOTICE_FONT_DIR = "/nonexistent/rentular/fonts";
    try {
      const dir = resolveFontDir();
      expect(existsSync(join(dir, "LiberationSans-Regular.ttf"))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.FORMAL_NOTICE_FONT_DIR;
      else process.env.FORMAL_NOTICE_FONT_DIR = before;
    }
  });

  it("throws a message naming every path it tried", () => {
    expect(() => resolveFontDir(["/no/such/dir-a", "/no/such/dir-b"])).toThrow(
      /^\[FormalNotice\] letter font not found\./,
    );
    expect(() => resolveFontDir(["/no/such/dir-a", "/no/such/dir-b"])).toThrow(/\/no\/such\/dir-a/);
    expect(() => resolveFontDir(["/no/such/dir-a", "/no/such/dir-b"])).toThrow(/\/no\/such\/dir-b/);
  });

  it("throws when there is no candidate at all", () => {
    expect(() => resolveFontDir([])).toThrow(/^\[FormalNotice\] letter font not found\./);
  });
});
