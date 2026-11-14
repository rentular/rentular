import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** An assertion failure (as opposed to a crash in the test code itself). */
export class TestFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestFailure";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TestFailure(message);
}

export interface TestResult {
  project: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  /** Fields swept by this test, for the summary of what was covered. */
  fields?: string[];
  warnings?: string[];
  artifacts?: string[];
}

export class Report {
  readonly results: TestResult[] = [];
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  add(r: TestResult): void {
    this.results.push(r);
    const mark = r.status === "passed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
    const fields = r.fields?.length ? ` (${r.fields.length} fields)` : "";
    console.log(`  ${mark}  [${r.project}] ${r.name}${fields}  ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.error) console.log(`        ${r.error.split("\n").join("\n        ")}`);
    for (const w of r.warnings ?? []) console.log(`        note: ${w}`);
  }

  get failed(): number {
    return this.results.filter((r) => r.status === "failed").length;
  }

  write(): void {
    const passed = this.results.filter((r) => r.status === "passed").length;
    const skipped = this.results.filter((r) => r.status === "skipped").length;
    const fieldCount = this.results.reduce((n, r) => n + (r.fields?.length ?? 0), 0);
    writeFileSync(path.join(this.dir, "results.json"), JSON.stringify(this.results, null, 2));

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const cases = this.results
      .map((r) => {
        const inner =
          r.status === "failed"
            ? `<failure message="${esc(r.error ?? "failed")}"/>`
            : r.status === "skipped"
              ? "<skipped/>"
              : "";
        return `  <testcase classname="${esc(r.project)}" name="${esc(r.name)}" time="${(r.durationMs / 1000).toFixed(2)}">${inner}</testcase>`;
      })
      .join("\n");
    writeFileSync(
      path.join(this.dir, "junit.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="rentular-e2e" tests="${this.results.length}" failures="${this.failed}" skipped="${skipped}">\n${cases}\n</testsuite>\n`
    );

    const lines = [
      `Rentular browser tests, ${new Date().toISOString()}`,
      `${passed} passed, ${this.failed} failed, ${skipped} skipped, ${fieldCount} fields typed into`,
      "",
      ...this.results.map(
        (r) =>
          `${r.status.toUpperCase().padEnd(7)} [${r.project}] ${r.name}` +
          (r.error ? `\n        ${r.error}` : "") +
          (r.artifacts?.length ? `\n        files: ${r.artifacts.join(", ")}` : "")
      ),
    ];
    writeFileSync(path.join(this.dir, "summary.txt"), lines.join("\n") + "\n");
    console.log("");
    console.log(lines[1]);
    console.log(`Report: ${this.dir}`);
  }
}
