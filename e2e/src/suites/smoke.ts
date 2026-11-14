import type { Locator, Page } from "playwright";
import { assert, TestFailure } from "../lib/report";
import { loginLandlord, open } from "../lib/session";
import type { TestCase } from "../lib/testing";
import { clickVisible, firstLeaseId, openDialog } from "./dashboardSweep";

/** The visible text input of a LocaleDateInput, found through its hidden named input. */
function dateField(scope: Locator, name: string): Locator {
  return scope.locator(`div:has(> input[name="${name}"]) > input[type="text"]`).first();
}

async function typeDate(field: Locator, ddmmyyyy: string): Promise<void> {
  await field.click();
  await field.fill("");
  await field.pressSequentially(ddmmyyyy);
  await field.press("Tab");
}

/** Strings that look like untranslated message keys, e.g. "leases.saveLease". */
async function rawKeys(page: Page): Promise<string[]> {
  const text = await page.locator("body").innerText();
  const found = text.match(/\b[a-z][a-zA-Z]+(?:\.[a-z][a-zA-Z0-9]+){1,3}\b/g) ?? [];
  return found.filter((s) => {
    const parts = s.split(".");
    // Domains and file names are not message keys.
    if (/^(com|be|org|net|eu|io|local|nl|fr|de|pdf|png|csv|xlsx|apk|json|js)$/i.test(parts[parts.length - 1])) return false;
    return parts.length >= 3 || parts.slice(1).some((p) => /[A-Z]/.test(p));
  });
}

async function assertTranslated(page: Page, where: string): Promise<void> {
  const keys = await rawKeys(page);
  assert(keys.length === 0, `${where}: untranslated keys on the page: ${[...new Set(keys)].slice(0, 5).join(", ")}`);
  const html = await page.content();
  assert(!/Rentulair/i.test(html), `${where}: "Rentulair" found in the page`);
}

export const smokeTests: TestCase[] = [
  {
    name: "smoke: add a tenant",
    skip: (cfg) => cfg.remote,
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      await open(page, "/tenants");
      const d = await openDialog(page, page.getByRole("button", { name: "Add Tenant" }), "Add Tenant");
      const last = `Smoke-${project}`;
      await d.locator('input[name="firstName"]').fill("Sam");
      await d.locator('input[name="lastName"]').fill(last);
      await d.locator('input[name="email"]').fill(`sam.${project}@e2e.local`);
      await d.getByRole("button", { name: "Save Tenant" }).click();
      await d.waitFor({ state: "hidden" });
      await page.getByText(last).filter({ visible: true }).first().waitFor();
    },
  },
  {
    name: "smoke: create a contract",
    skip: (cfg) => cfg.remote,
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      await open(page, "/leases");
      const before = await page.getByText(ctx.cfg.fixtures.propertyName).filter({ visible: true }).count();
      const d = await openDialog(page, page.getByRole("button", { name: "Add Lease" }), "Add Lease");
      await d.locator('select[name="propertyId"]').selectOption({ index: 1 });
      await d.locator('input[type="checkbox"]').first().check();
      await typeDate(dateField(d, "signingDate"), "01/02/2026");
      await typeDate(dateField(d, "startDate"), "01/03/2026");
      await d.locator('input[name="monthlyRent"]').fill("910");
      await d.getByRole("button", { name: "Save Lease" }).click();
      await d.waitFor({ state: "hidden", timeout: 15_000 }).catch(async () => {
        const msg = await d.locator('[role="alert"], .text-destructive, .text-red-600').allInnerTexts();
        throw new TestFailure(`saving the contract failed: ${msg.join(" | ") || "dialog stayed open"}`);
      });
      await page.waitForTimeout(1000);
      const after = await page.getByText(ctx.cfg.fixtures.propertyName).filter({ visible: true }).count();
      assert(after > before, `expected one more contract row for ${ctx.cfg.fixtures.propertyName} (before ${before}, after ${after})`);
    },
  },
  {
    name: "smoke: record a payment",
    skip: (cfg) => cfg.remote,
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      await open(page, "/payments");
      const d = await openDialog(page, page.getByRole("button", { name: "Add Payment", exact: true }), "Add Payment");
      await d.getByRole("button", { name: "Enter lease ID" }).click();
      await d.getByRole("button", { name: /Tess Tester/ }).first().click();
      await d.locator('input[type="number"]').first().fill("900");
      const date = d.locator('input[inputmode="numeric"]').first();
      await typeDate(date, "05/01/2026");
      await d.getByRole("button", { name: "Record Payment" }).click();
      await d.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {
        throw new TestFailure("the Record Payment dialog stayed open");
      });
    },
  },
  {
    name: "smoke: mute reminders until next week, then unmute",
    skip: (cfg) => cfg.remote,
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      await open(page, "/leases");
      const id = await firstLeaseId(ctx);
      await open(page, `/leases/${id}`);
      const d = await openDialog(page, page.getByRole("button", { name: /Mute reminders|Change/ }), "Mute reminders");
      await d.getByRole("button", { name: /Next week/ }).click();
      await d.getByRole("button", { name: "Mute", exact: true }).click();
      await d.waitFor({ state: "hidden" });
      await page.getByText(/Reminders muted until/).first().waitFor();
      page.once("dialog", (dlg) => void dlg.accept());
      await clickVisible(page, page.getByRole("button", { name: "Unmute" }), "Unmute");
      await page.getByText("Late payment reminders run as usual for this contract.").waitFor();
    },
  },
  {
    name: "smoke: contract communication page opens",
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      await open(page, "/leases");
      const id = await firstLeaseId(ctx);
      await open(page, `/leases/${id}`);
      await page.getByText(ctx.cfg.fixtures.propertyName).first().waitFor();
      await assertTranslated(page, "communication page");
    },
  },
  {
    name: "smoke: language switch NL, FR, DE, EN without raw keys or Rentulair",
    async run(ctx) {
      const { page, project } = ctx;
      await loginLandlord(page, project);
      const pages = ["/overview", "/tenants", "/leases", "/payments", "/settings"];
      const expectations: Record<string, { label: string; tenants: RegExp }> = {
        nl: { label: "Nederlands", tenants: /Huurders/ },
        fr: { label: "Francais", tenants: /Locataires/ },
        de: { label: "Deutsch", tenants: /Mieter/ },
        en: { label: "English", tenants: /Tenants/ },
      };
      for (const [code, exp] of Object.entries(expectations)) {
        await open(page, "/tenants");
        // The switcher sits in the sidebar on desktop and the menu on phones.
        const toggle = page.getByRole("button", { name: /^(EN|NL|FR|DE)$/ }).filter({ visible: true });
        if (!(await toggle.count())) {
          await clickVisible(page, page.getByRole("button", { name: /menu/i }), "the mobile menu");
        }
        await clickVisible(page, page.getByRole("button", { name: /^(EN|NL|FR|DE)$/ }), "the language switcher");
        await clickVisible(page, page.getByRole("button", { name: new RegExp(exp.label) }).or(page.getByRole("menuitem", { name: new RegExp(exp.label) })), `the ${exp.label} option`);
        await page.waitForFunction((c) => document.documentElement.lang === c, code, { timeout: 10_000 }).catch(() => {
          throw new TestFailure(`<html lang> did not become "${code}" after choosing ${exp.label}`);
        });
        await page.keyboard.press("Escape").catch(() => undefined);
        for (const p of pages) {
          await open(page, p);
          await page.waitForTimeout(500);
          await assertTranslated(page, `${p} in ${code}`);
        }
        await open(page, "/tenants");
        assert(exp.tenants.test(await page.locator("main").innerText()), `/tenants in ${code} does not show ${exp.tenants}`);
      }
    },
  },
  ...(["nl-BE", "fr-BE", "de-DE", "en-GB"] as const).map(
    (locale): TestCase => ({
      name: `smoke: <html lang> follows Accept-Language ${locale} without a cookie`,
      locale,
      async run(ctx) {
        const { page } = ctx;
        await open(page, "/login");
        const lang = await page.evaluate(() => document.documentElement.lang);
        assert(lang === locale.slice(0, 2), `expected <html lang="${locale.slice(0, 2)}">, got "${lang}"`);
        await assertTranslated(page, `login in ${locale}`);
      },
    })
  ),
];
