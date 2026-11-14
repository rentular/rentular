/**
 * Runs every suite in every requested browser project and writes a report
 * (summary.txt, results.json, junit.xml, screenshots and traces of failures)
 * to the artifacts folder. Exit code 0 means everything passed.
 */
import path from "node:path";
import { chromium, devices, webkit, type Browser, type BrowserContextOptions } from "playwright";
import { loadConfig, type ProjectName } from "./lib/config";
import { Report, TestFailure } from "./lib/report";
import type { TestCase, TestContext } from "./lib/testing";
import { authTests } from "./suites/auth";
import { onboardingTests } from "./suites/onboarding";
import { dashboardSweepTests } from "./suites/dashboardSweep";
import { smokeTests } from "./suites/smoke";

const PROJECTS: Record<ProjectName, { engine: "chromium" | "webkit"; options: BrowserContextOptions }> = {
  "chromium-desktop": { engine: "chromium", options: { viewport: { width: 1366, height: 900 } } },
  // Android phone, the platform of the Rentular app.
  "chromium-mobile": { engine: "chromium", options: { ...devices["Pixel 7"] } },
  "webkit-desktop": { engine: "webkit", options: { viewport: { width: 1366, height: 900 } } },
  "webkit-mobile": { engine: "webkit", options: { ...devices["iPhone 13"] } },
};

const ALL_TESTS: TestCase[] = [...authTests, ...onboardingTests, ...dashboardSweepTests, ...smokeTests];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

async function runTest(
  browser: Browser,
  project: ProjectName,
  test: TestCase,
  report: Report
): Promise<void> {
  const cfg = loadConfig();
  const started = Date.now();
  if (test.skip?.(cfg)) {
    report.add({ project, name: test.name, status: "skipped", durationMs: 0 });
    return;
  }
  const context = await browser.newContext({
    ...PROJECTS[project].options,
    locale: test.locale ?? "en-US",
    timezoneId: "Europe/Brussels",
  });
  context.setDefaultTimeout(15_000);
  // tsx (esbuild keepNames) wraps named functions in __name(); functions we
  // pass to page.evaluate run in the page, where that helper does not exist.
  await context.addInitScript("globalThis.__name = (f) => f");
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  const ctx: TestContext = { page, context, project, cfg, fields: [], warnings: [] };
  try {
    await test.run(ctx);
    await context.tracing.stop();
    report.add({
      project,
      name: test.name,
      status: "passed",
      durationMs: Date.now() - started,
      fields: ctx.fields,
      warnings: ctx.warnings,
    });
  } catch (err) {
    const base = path.join(report.dir, `${project}--${slug(test.name)}`);
    const artifacts: string[] = [];
    await page.screenshot({ path: `${base}.png`, fullPage: true }).then(
      () => artifacts.push(path.basename(`${base}.png`)),
      () => undefined
    );
    await context.tracing.stop({ path: `${base}.trace.zip` }).then(
      () => artifacts.push(path.basename(`${base}.trace.zip`)),
      () => undefined
    );
    const msg = err instanceof TestFailure ? err.message : err instanceof Error ? err.stack ?? err.message : String(err);
    const extra = consoleErrors.length ? `\npage errors: ${consoleErrors.slice(0, 3).join(" | ")}` : "";
    report.add({
      project,
      name: test.name,
      status: "failed",
      durationMs: Date.now() - started,
      error: `${msg}${extra} (url: ${page.url()})`,
      fields: ctx.fields,
      warnings: ctx.warnings,
      artifacts,
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const report = new Report(cfg.artifactsDir);
  const filter = process.env.E2E_GREP ? new RegExp(process.env.E2E_GREP, "i") : null;
  const tests = filter ? ALL_TESTS.filter((t) => filter.test(t.name)) : ALL_TESTS;
  console.log(`Testing ${cfg.baseUrl} with ${tests.length} tests in ${cfg.projects.join(", ")}`);

  for (const project of cfg.projects) {
    const { engine } = PROJECTS[project];
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: !cfg.headed });
    console.log(`\n${project}`);
    try {
      for (const test of tests) await runTest(browser, project, test, report);
    } finally {
      await browser.close();
    }
  }
  report.write();
  return report.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error("[e2e] runner crashed:", err);
    process.exit(2);
  }
);
