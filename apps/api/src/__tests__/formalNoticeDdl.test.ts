/**
 * Guard for the hand-written production DDL in packages/db/sql/formal-notice.sql.
 *
 * Two things are easy to get wrong by hand and expensive to get wrong in
 * production:
 *  - MariaDB stores ENUM values as ordinal indexes and has no ADD VALUE, so the
 *    whole list has to be restated and the new value has to be appended LAST.
 *    If the SQL list ever drifts from the Drizzle schema array, reads come back
 *    labelled as the wrong kind.
 *  - the file is applied by hand on a shared production box, so it must stay
 *    additive and idempotent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { communications } from "@rentular/db";

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/src/__tests__ -> repo root
const ddlPath = resolve(here, "../../../../packages/db/sql/formal-notice.sql");

const raw = readFileSync(ddlPath, "utf8");
/** The file without its comment lines, so prose cannot satisfy these checks. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

/** Quoted values inside the communications `MODIFY COLUMN type ENUM(...)`. */
function ddlEnumValues(): string[] {
  const match = /MODIFY\s+COLUMN\s+type\s+ENUM\s*\(([^)]*)\)/i.exec(sql);
  if (!match) throw new Error("no MODIFY COLUMN type ENUM(...) found in formal-notice.sql");
  return match[1]
    .split(",")
    .map((v) => v.trim().replace(/^'(.*)'$/, "$1"))
    .filter((v) => v.length > 0);
}

describe("packages/db/sql/formal-notice.sql", () => {
  it("restates the communications type enum exactly as the Drizzle schema has it", () => {
    const schemaValues = [...communications.type.enumValues];
    expect(ddlEnumValues()).toEqual(schemaValues);
  });

  it("appends formal_notice last and nowhere else", () => {
    const schemaValues = [...communications.type.enumValues];
    expect(schemaValues).toHaveLength(16);
    expect(schemaValues[schemaValues.length - 1]).toBe("formal_notice");
    expect(schemaValues.filter((v) => v === "formal_notice")).toHaveLength(1);

    const ddlValues = ddlEnumValues();
    expect(ddlValues).toHaveLength(16);
    expect(ddlValues[ddlValues.length - 1]).toBe("formal_notice");
  });

  it("is additive only: no DROP, TRUNCATE, DELETE or RENAME", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it("guards every column add with IF NOT EXISTS so it can be re-run", () => {
    const adds = sql.match(/ADD\s+COLUMN/gi) ?? [];
    const guarded = sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi) ?? [];
    expect(adds.length).toBe(12);
    expect(guarded.length).toBe(adds.length);
  });

  it("adds the six sender-address columns on users", () => {
    for (const column of [
      "street",
      "street_number",
      "box",
      "postal_code",
      "city",
      "country",
    ]) {
      expect(sql).toMatch(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\b`, "i")
      );
    }
  });

  it("adds the six correspondence-address columns on tenants", () => {
    for (const column of [
      "correspondence_street",
      "correspondence_street_number",
      "correspondence_box",
      "correspondence_postal_code",
      "correspondence_city",
      "correspondence_country",
    ]) {
      expect(sql).toMatch(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\b`, "i")
      );
    }
  });
});
