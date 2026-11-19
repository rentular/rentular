/**
 * Drawing a LetterDocument on A4 pages.
 *
 * This is the only module in the repo that imports pdfkit, so page size,
 * margins, fonts and pagination are decided in exactly one place. It knows
 * nothing about leases or arrears: it places the blocks of a LetterDocument
 * and breaks tables across pages.
 *
 * Two things here are load-bearing and easy to lose:
 *
 * - The letter fonts are the committed Liberation Sans TTFs, registered with
 *   registerFont. The built-in Helvetica is single-byte WinAnsi and corrupts
 *   any name outside Latin-1 silently, with no exception and no warning. A
 *   formal notice ends up in a court file, so a mangled tenant name is not a
 *   cosmetic bug.
 * - Every string is normalised to NFC inside the one draw helper. A
 *   decomposed accent (an "e" followed by a combining grave) renders as
 *   garbage even with an embedded font, and web form input from macOS
 *   clients arrives decomposed.
 *
 * The font directory is resolved from this module's own location, never from
 * process.cwd(): production runs tsx from src/, the tsup bundle lives in
 * dist/, and PM2's cwd is not a contract. No request value, tenant name or
 * lease id reaches a filesystem path here.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { LetterBlock, LetterDocument } from "./letterDocument";

const REGULAR_TTF = "LiberationSans-Regular.ttf";
const BOLD_TTF = "LiberationSans-Bold.ttf";

/** Relative to this module: tsx from src/lib, the tsup bundle in dist, flat. */
const FONT_DIR_CANDIDATES = ["../../assets/fonts", "../assets/fonts", "./assets/fonts"];

const BODY = "letter-body";
const BOLD = "letter-bold";

/** A4 in PostScript points. */
const PAGE_HEIGHT = 841.89;

const MARGIN_TOP = 57;
const MARGIN_BOTTOM = 57;
const MARGIN_LEFT = 71;
const MARGIN_RIGHT = 71;

const CONTENT_WIDTH = 453;
const CONTENT_RIGHT = MARGIN_LEFT + CONTENT_WIDTH;
const BOTTOM_LIMIT = PAGE_HEIGHT - MARGIN_BOTTOM;

/** The right-hand window of a Belgian envelope: 115 mm across, 50 mm down. */
const ADDRESSEE_X = 326;
const ADDRESSEE_Y = 142;
const ADDRESSEE_WIDTH = 227;

/** The body never starts higher than this, whatever the postal blocks do. */
const MIN_BODY_Y = 227;

const SENDER_SIZE = 9.5;
const ADDRESSEE_SIZE = 11;
const DATE_SIZE = 10.5;
const SUBJECT_SIZE = 11;
const BODY_SIZE = 10.5;
const TABLE_SIZE = 10;
const FOOTER_SIZE = 9;

const BLOCK_GAP = 8;
const RULE_WIDTH = 0.5;
const AMOUNT_VALUE_WIDTH = 120;
/** Closing line, room for a pen, name: a signature block needs this much. */
const SIGNATURE_HEIGHT = 96;
const SIGNATURE_SPACE = 54;

let cachedFontDir: string | null = null;

/** Precomposed form, so a combining accent never reaches the font. */
export function normaliseLetterText(text: string): string {
  return text.normalize("NFC");
}

function candidateList(): string[] {
  const fromEnv = process.env.FORMAL_NOTICE_FONT_DIR;
  // Only an absolute path: a relative one would depend on the working
  // directory, which is exactly what this resolver exists to avoid.
  return fromEnv && isAbsolute(fromEnv) ? [fromEnv, ...FONT_DIR_CANDIDATES] : [...FONT_DIR_CANDIDATES];
}

/**
 * The directory holding both letter TTFs. Candidates are tried in order and
 * the first directory holding both files wins; the error names every path
 * tried, because the only way this fails is a deployment that did not ship
 * the assets, and the message is the whole diagnosis.
 */
export function resolveFontDir(candidates?: string[]): string {
  const explicit = candidates !== undefined;
  if (!explicit && cachedFontDir) return cachedFontDir;

  const here = dirname(fileURLToPath(import.meta.url));
  const tried: string[] = [];
  for (const candidate of explicit ? candidates : candidateList()) {
    const dir = isAbsolute(candidate) ? candidate : join(here, candidate);
    tried.push(dir);
    if (existsSync(join(dir, REGULAR_TTF)) && existsSync(join(dir, BOLD_TTF))) {
      if (!explicit) cachedFontDir = dir;
      return dir;
    }
  }
  throw new Error(`[FormalNotice] letter font not found. Tried: ${tried.join(", ")}`);
}

export interface RenderLetterOptions {
  /** Off only for tests that read the page dictionaries. */
  compress?: boolean;
}

type Doc = PDFKit.PDFDocument;

/** The one place a string reaches the font. */
function draw(doc: Doc, text: string, x: number, y: number, options: PDFKit.Mixins.TextOptions): void {
  doc.text(normaliseLetterText(text), x, y, options);
}

function fontFor(bold: boolean | undefined): string {
  return bold ? BOLD : BODY;
}

/** Start a new page when `height` would not fit above the bottom margin. */
function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > BOTTOM_LIMIT) doc.addPage();
}

function rule(doc: Doc, y: number): void {
  doc
    .save()
    .lineWidth(RULE_WIDTH)
    .moveTo(MARGIN_LEFT, y)
    .lineTo(CONTENT_RIGHT, y)
    .stroke()
    .restore();
}

function drawParagraph(doc: Doc, block: Extract<LetterBlock, { kind: "paragraph" }>): void {
  doc.font(fontFor(block.bold)).fontSize(BODY_SIZE);
  draw(doc, block.text, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH, align: "left" });
}

function drawAmounts(doc: Doc, block: Extract<LetterBlock, { kind: "amounts" }>): void {
  doc.fontSize(BODY_SIZE);
  const labelWidth = CONTENT_WIDTH - AMOUNT_VALUE_WIDTH - 8;
  for (const row of block.rows) {
    doc.font(fontFor(row.bold));
    const lineHeight = doc.currentLineHeight() + 3;
    ensureSpace(doc, lineHeight + (row.bold ? 6 : 0));
    if (row.bold) {
      rule(doc, doc.y);
      doc.y += 4;
    }
    const top = doc.y;
    draw(doc, row.label, MARGIN_LEFT, top, { width: labelWidth, lineBreak: false });
    draw(doc, row.value, CONTENT_RIGHT - AMOUNT_VALUE_WIDTH, top, {
      width: AMOUNT_VALUE_WIDTH,
      align: "right",
      lineBreak: false,
    });
    doc.y = top + lineHeight;
  }
}

function drawTable(doc: Doc, block: Extract<LetterBlock, { kind: "table" }>): void {
  const widths = block.columns.map((column) => (column.widthPercent / 100) * CONTENT_WIDTH);
  const offsets: number[] = [];
  let x = MARGIN_LEFT;
  for (const width of widths) {
    offsets.push(x);
    x += width;
  }

  const drawHeader = (): void => {
    doc.font(BOLD).fontSize(TABLE_SIZE);
    const top = doc.y;
    block.columns.forEach((column, i) => {
      draw(doc, column.header, offsets[i]!, top, {
        width: widths[i]! - 6,
        align: column.align,
        lineBreak: false,
      });
    });
    const bottom = top + doc.currentLineHeight() + 3;
    rule(doc, bottom);
    doc.y = bottom + 4;
  };

  doc.font(BOLD).fontSize(TABLE_SIZE);
  const headerHeight = doc.currentLineHeight() + 7;
  ensureSpace(doc, headerHeight + 20);
  drawHeader();

  doc.font(BODY).fontSize(TABLE_SIZE);
  for (const row of block.rows) {
    const height =
      Math.max(
        ...row.map((cell, i) =>
          doc.heightOfString(normaliseLetterText(cell), { width: widths[i]! - 6 }),
        ),
      ) + 3;
    if (doc.y + height > BOTTOM_LIMIT) {
      doc.addPage();
      drawHeader();
      doc.font(BODY).fontSize(TABLE_SIZE);
    }
    const top = doc.y;
    row.forEach((cell, i) => {
      draw(doc, cell, offsets[i]!, top, {
        width: widths[i]! - 6,
        align: block.columns[i]?.align ?? "left",
        lineBreak: false,
      });
    });
    doc.y = top + height;
  }
}

function drawSignature(doc: Doc, block: Extract<LetterBlock, { kind: "signature" }>): void {
  doc.font(BODY).fontSize(BODY_SIZE);
  ensureSpace(doc, SIGNATURE_HEIGHT);
  draw(doc, block.closing, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
  doc.y += SIGNATURE_SPACE;
  draw(doc, block.name, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
}

function drawBlock(doc: Doc, block: LetterBlock): void {
  switch (block.kind) {
    case "paragraph":
      drawParagraph(doc, block);
      return;
    case "table":
      drawTable(doc, block);
      return;
    case "amounts":
      drawAmounts(doc, block);
      return;
    case "signature":
      drawSignature(doc, block);
      return;
  }
}

/**
 * A closing paragraph and the signature belong together: a signature standing
 * alone on a last page looks like a different document was stapled on. When
 * the two do not fit, the page break goes before the paragraph.
 */
function keepSignatureWithParagraph(doc: Doc, block: LetterBlock, next: LetterBlock | undefined): void {
  if (block.kind !== "paragraph" || next?.kind !== "signature") return;
  doc.font(fontFor(block.bold)).fontSize(BODY_SIZE);
  const height = doc.heightOfString(normaliseLetterText(block.text), { width: CONTENT_WIDTH });
  if (doc.y + height + BLOCK_GAP + SIGNATURE_HEIGHT > BOTTOM_LIMIT) doc.addPage();
}

function drawPostalBlocks(doc: Doc, document: LetterDocument): number {
  let senderBottom = MARGIN_TOP;
  if (document.senderLines.length > 0) {
    doc.font(BODY).fontSize(SENDER_SIZE);
    draw(doc, document.senderLines.join("\n"), MARGIN_LEFT, MARGIN_TOP, {
      width: CONTENT_WIDTH,
      lineGap: 1,
    });
    senderBottom = doc.y;
  }
  let addresseeBottom = ADDRESSEE_Y;
  if (document.addresseeLines.length > 0) {
    doc.font(BODY).fontSize(ADDRESSEE_SIZE);
    draw(doc, document.addresseeLines.join("\n"), ADDRESSEE_X, ADDRESSEE_Y, {
      width: ADDRESSEE_WIDTH,
      lineGap: 1,
    });
    addresseeBottom = doc.y;
  }
  return Math.max(Math.max(senderBottom, addresseeBottom) + 28, MIN_BODY_Y);
}

/** "2 / 3" in the bottom margin, only on a letter of more than one page. */
function drawPageNumbers(doc: Doc): void {
  const range = doc.bufferedPageRange();
  if (range.count < 2) return;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Writing inside the bottom margin would otherwise trigger a new page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(BODY).fontSize(FOOTER_SIZE);
    doc.text(`${i + 1} / ${range.count}`, MARGIN_LEFT, PAGE_HEIGHT - MARGIN_BOTTOM + 20, {
      width: CONTENT_WIDTH,
      align: "center",
      lineBreak: false,
    });
    doc.page.margins.bottom = bottom;
  }
}

function drawLetter(doc: Doc, document: LetterDocument): void {
  doc.y = drawPostalBlocks(doc, document);

  if (document.placeAndDate !== "") {
    doc.font(BODY).fontSize(DATE_SIZE);
    draw(doc, document.placeAndDate, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
    doc.y += BLOCK_GAP + 6;
  }

  doc.font(BOLD).fontSize(SUBJECT_SIZE);
  draw(doc, document.subject, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
  doc.y += BLOCK_GAP;

  document.blocks.forEach((block, i) => {
    keepSignatureWithParagraph(doc, block, document.blocks[i + 1]);
    drawBlock(doc, block);
    doc.y += BLOCK_GAP;
  });

  drawPageNumbers(doc);
}

/**
 * The letter as PDF bytes. The buffer is only complete after the "end" event,
 * so this has to be awaited: a zero-byte or truncated PDF means it was not.
 */
export async function renderLetterPdf(
  document: LetterDocument,
  opts: RenderLetterOptions = {},
): Promise<Buffer> {
  const fontDir = resolveFontDir();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_LEFT, right: MARGIN_RIGHT },
    info: { Title: document.title },
    compress: opts.compress !== false,
    bufferPages: true,
    autoFirstPage: true,
  });
  doc.registerFont(BODY, join(fontDir, REGULAR_TTF));
  doc.registerFont(BOLD, join(fontDir, BOLD_TTF));
  // Select the embedded font before anything is drawn, so the built-in
  // Helvetica is never written into the document.
  doc.font(BODY);

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err: Error) => reject(err));
  });

  drawLetter(doc, document);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
