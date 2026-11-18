/**
 * The shape of a printable letter, between the module that writes the words
 * and the module that draws them.
 *
 * The renderer in lib/pdfLetter.ts draws this structure and knows nothing
 * about leases, arrears or tenants: it places blocks on A4 pages and breaks
 * tables across them. Everything legal or linguistic is decided before a
 * LetterDocument exists.
 */

import type { LetterLanguage } from "./belgianFormat";

/** One drawable element of a letter body. */
export type LetterBlock =
  | { kind: "paragraph"; text: string; bold?: boolean }
  | {
      kind: "table";
      columns: Array<{ header: string; align: "left" | "right"; widthPercent: number }>;
      rows: string[][];
    }
  | { kind: "amounts"; rows: Array<{ label: string; value: string; bold?: boolean }> }
  | { kind: "signature"; closing: string; name: string };

/** A complete letter: the postal blocks, the subject and the body blocks. */
export type LetterDocument = {
  language: LetterLanguage;
  /** Document title for the PDF metadata, not drawn on the page. */
  title: string;
  senderLines: string[];
  addresseeLines: string[];
  /** "Leuven, 18 november 2026", or empty to leave the line out. */
  placeAndDate: string;
  subject: string;
  blocks: LetterBlock[];
};
