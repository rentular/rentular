import type { BrowserContext, Locator, Page } from "playwright";
import type { E2eConfig, ProjectName } from "./config";
import { sweepFields } from "./focus";
import { TestFailure } from "./report";

export interface TestContext {
  page: Page;
  context: BrowserContext;
  project: ProjectName;
  cfg: E2eConfig;
  /** Fields typed into, collected for the report. */
  fields: string[];
  /** Non-fatal notes, e.g. a field that reformats what was typed. */
  warnings: string[];
}

export interface TestCase {
  name: string;
  /** Browser locale; also sets Accept-Language. Default en-US. */
  locale?: string;
  skip?: (cfg: E2eConfig) => boolean;
  run: (ctx: TestContext) => Promise<void>;
}

/** Sweeps all typable fields in `scope` and records them on the test. */
export async function sweep(
  ctx: TestContext,
  scope: Locator,
  label: string,
  opts: { min?: number; skip?: RegExp } = {}
): Promise<void> {
  const res = await sweepFields(ctx.page, scope, label, { skip: opts.skip });
  ctx.fields.push(...res.fields.map((f) => `${label}: ${f}`));
  ctx.warnings.push(...res.warnings.map((w) => `${w.field}: ${w.message}`));
  const min = opts.min ?? 1;
  if (res.count < min) {
    throw new TestFailure(`${label}: expected at least ${min} typable fields, found ${res.count}`);
  }
}
