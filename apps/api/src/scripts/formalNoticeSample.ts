/**
 * Sample formal notices, and a self-check of the letter renderer.
 *
 *   pnpm --filter @rentular/api exec tsx src/scripts/formalNoticeSample.ts [outDir]
 *
 * Two jobs in one script. It writes eight letters (four languages, three and
 * twelve arrears months) for a human to read on paper, and it asserts that
 * what it wrote is a real PDF with the letter font embedded. The assertions
 * are the point: pdfkit tracks Dependabot, and a renderer that silently
 * stops embedding glyphs would otherwise keep producing files that look fine
 * in a file listing and are wrong on the page. Run it after a pdfkit bump.
 *
 * It needs no database, no network and no .env file: everything it draws is a
 * fixture. Exit code 0 means pass, non-zero means do not ship the bump.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderLetterPdf } from "../lib/pdfLetter";
import type { LetterLanguage } from "../lib/belgianFormat";
import {
  buildFormalNotice,
  computeFormalNoticeTotals,
  type FormalNoticeArrearsRow,
  type FormalNoticeTotals,
} from "../services/formalNoticeText";
import {
  arrearsNoticeParams,
  arrearsNoticeRows,
  arrearsRows,
  letterInterest,
  COTENANT_NAME,
} from "../services/__tests__/fixtures/arrearsLease";

const LANGUAGES: LetterLanguage[] = ["nl", "fr", "de", "en"];
const MONTH_COUNTS = [3, 12] as const;
const ANNUAL_INTEREST_RATE = 3.75;
const FEE_AMOUNT = 15;

/**
 * Characters that do not exist in the single-byte encoding of the built-in
 * PDF fonts. Each one has to turn up in the document's ToUnicode map, which
 * only happens when the glyph was really subset out of the embedded TTF.
 */
const NON_LATIN1_GLYPHS = [
  { char: "Ł", name: "LATIN CAPITAL LETTER L WITH STROKE" },
  { char: "ş", name: "LATIN SMALL LETTER S WITH CEDILLA" },
  { char: "ı", name: "LATIN SMALL LETTER DOTLESS I" },
];

/** The installed pdfkit version, read from the package on disk. */
function pdfkitVersion(): string {
  try {
    const require_ = createRequire(import.meta.url);
    let dir = dirname(require_.resolve("pdfkit"));
    // pdfkit's exports map hides ./package.json, so walk up to it.
    for (let depth = 0; depth < 6; depth++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "pdfkit" && pkg.version) return pkg.version;
      } catch {
        // No package.json at this level, keep walking.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the unknown marker below.
  }
  return "unknown";
}

function totalsFor(rows: FormalNoticeArrearsRow[]): FormalNoticeTotals {
  return computeFormalNoticeTotals(
    {
      rows,
      rentOwed: rows.reduce((sum, row) => sum + row.shortfall, 0),
      interestEnabled: true,
      annualInterestRate: ANNUAL_INTEREST_RATE,
      feeEnabled: true,
      feeAmount: FEE_AMOUNT,
    },
    letterInterest,
  );
}

function sampleRows(months: number): FormalNoticeArrearsRow[] {
  return months === 3 ? arrearsNoticeRows() : arrearsRows(months);
}

function noticeDocument(language: LetterLanguage, months: number) {
  const rows = sampleRows(months);
  return buildFormalNotice(
    arrearsNoticeParams({ tenantLanguage: language, rows, totals: totalsFor(rows) }),
  ).document;
}

/** Hex as a ToUnicode CMap writes a code point: "<0141>". */
function cmapEntry(char: string): string {
  return `<${char.codePointAt(0)!.toString(16).padStart(4, "0")}>`;
}

async function main(): Promise<void> {
  const outDir = process.argv[2] || join(tmpdir(), "formal-notice-samples");
  const version = pdfkitVersion();
  const failures: string[] = [];

  console.log(`[FormalNoticeSample] pdfkit ${version}`);
  mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const language of LANGUAGES) {
    for (const months of MONTH_COUNTS) {
      const path = join(outDir, `formal-notice-${language}-${months}.pdf`);
      const bytes = await renderLetterPdf(noticeDocument(language, months));
      writeFileSync(path, bytes);
      written++;
      console.log(`[FormalNoticeSample] wrote ${path} (${bytes.length} bytes)`);
      if (bytes.length === 0) failures.push(`${path} is empty`);
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
        failures.push(`${path} has no %PDF- header`);
      }
    }
  }

  // The glyph check needs the uncompressed bytes: with compression on, the
  // ToUnicode map sits inside a flate stream and cannot be read here.
  const base = noticeDocument("nl", 3);
  const probe = await renderLetterPdf(
    {
      ...base,
      addresseeLines: [...base.addresseeLines, COTENANT_NAME],
    },
    { compress: false },
  );
  const raw = probe.toString("latin1");
  if (!raw.includes("FontFile2")) failures.push("no embedded font program (FontFile2) in the letter");
  if (raw.includes("/BaseFont /Helvetica")) failures.push("the letter fell back to the built-in Helvetica");
  const embedded = NON_LATIN1_GLYPHS.filter((glyph) => raw.includes(cmapEntry(glyph.char)));
  if (embedded.length === 0) {
    failures.push(
      `no glyph outside Latin-1 embedded: looked for ${NON_LATIN1_GLYPHS.map((g) => cmapEntry(g.char)).join(", ")}`,
    );
  } else {
    console.log(
      `[FormalNoticeSample] glyphs outside Latin-1 embedded: ${embedded
        .map((glyph) => `${glyph.char} ${cmapEntry(glyph.char)} (${glyph.name})`)
        .join(", ")}`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FormalNoticeSample] ${failure}`);
    console.error(`FAIL: letter renderer check failed on pdfkit ${version} (${failures.length} problems)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS: ${written} sample letters written to ${outDir}, A4 PDFs with the letter font embedded, pdfkit ${version}`,
  );
}

main().catch((err) => {
  console.error("[FormalNoticeSample] threw:", err);
  console.error("FAIL: the letter renderer threw before it could be checked");
  process.exit(1);
});
