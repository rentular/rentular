import type { Locator, Page } from "playwright";
import { TestFailure } from "../lib/report";
import { loginLandlord, open } from "../lib/session";
import type { TestCase, TestContext } from "../lib/testing";
import { sweep } from "../lib/testing";
import { settle } from "../lib/focus";

/** The open Radix dialog (Dialog or AlertDialog). */
export function dialog(page: Page): Locator {
  return page.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true }).last();
}

export async function clickVisible(page: Page, target: Locator, what: string): Promise<void> {
  const el = target.filter({ visible: true }).first();
  await el.waitFor({ timeout: 15_000 }).catch(() => {
    throw new TestFailure(`could not find ${what} on ${page.url()}`);
  });
  await el.click();
}

export async function openDialog(page: Page, trigger: Locator, what: string): Promise<Locator> {
  await clickVisible(page, trigger, what);
  const d = dialog(page);
  await d.waitFor({ timeout: 10_000 }).catch(() => {
    throw new TestFailure(`${what} did not open a dialog`);
  });
  await settle(d);
  return d;
}

/** First lease id of the signed-in user, read through the API like the app does. */
export async function firstLeaseId(ctx: TestContext): Promise<string> {
  const id = await ctx.page.evaluate(async (api) => {
    const res = await fetch(`${api}/leases`, { credentials: "include" });
    const body = (await res.json()) as { data?: Array<{ id: string }> } | Array<{ id: string }>;
    const list = Array.isArray(body) ? body : (body.data ?? []);
    return list[0]?.id ?? null;
  }, ctx.cfg.apiUrl);
  if (!id) throw new TestFailure("the landlord has no lease to open");
  return id;
}

function landlordSweep(
  name: string,
  path: string,
  body: (ctx: TestContext) => Promise<void>
): TestCase {
  return {
    name: `focus: ${name}`,
    async run(ctx) {
      await loginLandlord(ctx.page, ctx.project);
      await open(ctx.page, path);
      await body(ctx);
    },
  };
}

const main = (page: Page): Locator => page.locator("main").first();

export const dashboardSweepTests: TestCase[] = [
  landlordSweep("properties add and edit dialogs", "/properties", async (ctx) => {
    const { page } = ctx;
    let d = await openDialog(page, page.getByRole("button", { name: "Add Property" }), "Add Property");
    await sweep(ctx, d, "add property", { min: 5 });
    await page.keyboard.press("Escape");
    await d.waitFor({ state: "hidden" });
    d = await openDialog(page, page.getByText(ctx.cfg.fixtures.propertyName), "the seeded property");
    await sweep(ctx, d, "edit property", { min: 5 });
  }),

  landlordSweep("property managers invite form", "/properties", async (ctx) => {
    const { page } = ctx;
    await clickVisible(page, page.locator('a[href$="/managers"]'), "the managers link");
    await page.waitForURL(/\/managers/);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const invite = page.getByRole("button", { name: "Invite Manager" }).filter({ visible: true });
    if (await invite.count()) {
      const d = await openDialog(page, invite, "Invite Manager");
      await sweep(ctx, d, "invite manager", { min: 1 });
    } else {
      await sweep(ctx, main(page), "property managers page", { min: 1 });
    }
  }),

  landlordSweep("tenants search, add and edit dialogs", "/tenants", async (ctx) => {
    const { page } = ctx;
    await sweep(ctx, main(page).locator('input[placeholder="Search tenants..."]').locator(".."), "tenant search");
    await page.getByPlaceholder("Search tenants...").fill("");
    let d = await openDialog(page, page.getByRole("button", { name: "Add Tenant" }), "Add Tenant");
    // Reveal the tenant bank account (IBAN) fields as well.
    await d.getByRole("button", { name: "Add account" }).click().catch(() => undefined);
    await sweep(ctx, d, "add tenant", { min: 3 });
    await page.keyboard.press("Escape");
    await d.waitFor({ state: "hidden" });
    // Desktop shows first and last name in separate cells, so use the email.
    d = await openDialog(page, page.getByText(ctx.cfg.fixtures.tenantEmail), "the seeded tenant");
    await sweep(ctx, d, "edit tenant", { min: 3 });
  }),

  landlordSweep("leases search, add and edit contract form", "/leases", async (ctx) => {
    const { page } = ctx;
    await sweep(ctx, page.getByPlaceholder("Search leases...").locator(".."), "lease search");
    await page.getByPlaceholder("Search leases...").fill("");
    let d = await openDialog(page, page.getByRole("button", { name: "Add Lease" }), "Add Lease");
    // Flip the "Lease registered" switch so its area is exercised too.
    await d.getByRole("switch", { name: "Lease registered" }).click();
    await sweep(ctx, d, "add contract", { min: 8 });
    await page.keyboard.press("Escape");
    await d.waitFor({ state: "hidden" });
    d = await openDialog(page, page.getByText(ctx.cfg.fixtures.propertyName), "the seeded contract");
    await sweep(ctx, d, "edit contract", { min: 8 });
  }),

  landlordSweep("contract communication page and reminder mute dialog", "/leases", async (ctx) => {
    const { page } = ctx;
    const id = await firstLeaseId(ctx);
    await open(page, `/leases/${id}`);
    await sweep(ctx, main(page), "contract communication page", { min: 0 });
    const d = await openDialog(page, page.getByRole("button", { name: "Mute reminders" }), "Mute reminders");
    await d.getByRole("button", { name: /Pick a date/ }).click().catch(() => undefined);
    await sweep(ctx, d, "reminder mute dialog", { min: 1 });
  }),

  landlordSweep("payments dialogs", "/payments", async (ctx) => {
    const { page } = ctx;
    for (const [button, label, min] of [
      ["Add Payment", "record payment", 2],
      ["Add Cost", "add cost", 2],
      ["Rent-Free Period", "rent-free period", 1],
      ["Deduction", "deduction", 1],
    ] as const) {
      const d = await openDialog(page, page.getByRole("button", { name: button, exact: true }), button);
      // Some dialogs only show their fields once a contract is chosen.
      const select = d.locator("select").first();
      if (await select.count()) await select.selectOption({ index: 1 }).catch(() => undefined);
      await sweep(ctx, d, label, { min });
      await page.keyboard.press("Escape");
      await d.waitFor({ state: "hidden" });
    }
    // Ignore reason: Actions menu on a payment row.
    await clickVisible(page, page.getByRole("button", { name: "Actions" }), "the payment Actions menu");
    await page.getByRole("menuitem", { name: "Not rent-related" }).click();
    const d = dialog(page);
    await d.waitFor();
    await settle(d);
    await sweep(ctx, d, "ignore reason", { min: 1 });
  }),

  landlordSweep("settings tabs", "/settings", async (ctx) => {
    const { page } = ctx;
    for (const tab of ["Payment Follow-up", "Landlord Reports", "Bank Accounts", "GoCardless", "Profile", "API tokens"]) {
      await clickVisible(page, page.getByRole("tab", { name: tab }).or(page.getByRole("button", { name: tab, exact: true })), `the ${tab} tab`);
      await page.waitForTimeout(500);
      const add = page.getByRole("button", { name: "Add bank account" }).filter({ visible: true });
      if (tab === "Bank Accounts" && (await add.count())) await add.first().click();
      await sweep(ctx, main(page), `settings ${tab}`, { min: 0 });
    }
  }),

  landlordSweep("Enable Banking wizard application id", "/bank-connections/enable-banking?step=4", async (ctx) => {
    const { page } = ctx;
    const appId = page.locator("#eb-app-id");
    for (let i = 0; i < 4 && !(await appId.isVisible().catch(() => false)); i++) {
      const nextBtn = page.getByRole("button", { name: "Next" }).filter({ visible: true });
      if (!(await nextBtn.count()) || !(await nextBtn.first().isEnabled())) break;
      await nextBtn.first().click();
      await page.waitForTimeout(300);
    }
    if (!(await appId.isVisible().catch(() => false))) {
      throw new TestFailure("could not reach the application id field of the Enable Banking wizard");
    }
    await sweep(ctx, main(page), "Enable Banking wizard", { min: 1 });
  }),

  landlordSweep("other pages with inputs (mandates, maintenance, import, communications)", "/mandates", async (ctx) => {
    const { page } = ctx;
    await sweep(ctx, main(page), "mandates", { min: 1 });
    await open(page, "/maintenance");
    const d = await openDialog(page, page.getByRole("button", { name: "Add task" }), "Add task");
    await sweep(ctx, d, "maintenance add task", { min: 1 });
    await page.keyboard.press("Escape");
    await open(page, "/import");
    await sweep(ctx, main(page), "import", { min: 1 });
    await open(page, "/communications");
    await sweep(ctx, main(page), "communications", { min: 0 });
    await open(page, "/overview");
    await sweep(ctx, main(page), "overview", { min: 0 });
  }),
];
