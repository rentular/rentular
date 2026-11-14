import type { Page } from "playwright";
import { onboardingEmailFor } from "../lib/config";
import { assert, TestFailure } from "../lib/report";
import { login } from "../lib/session";
import type { TestCase } from "../lib/testing";
import { sweep } from "../lib/testing";
import { typeAndAssertFocus } from "../lib/focus";

async function next(page: Page, expectHeading: string): Promise<void> {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  // The step indicator shows every title, so wait for the step's own heading.
  await page.getByRole("heading", { name: expectHeading, exact: true }).waitFor({ timeout: 15_000 }).catch(() => {
    throw new TestFailure(`onboarding did not reach "${expectHeading}"`);
  });
}

/**
 * The bug that started this suite: in the "Add a tenant" step every typed
 * letter moved focus to the Next button. Walks the whole wizard as a new
 * landlord, typing into every field of every step, then finishes it.
 */
export const onboardingTests: TestCase[] = [
  {
    name: "onboarding: type into every step and finish setup",
    // Remote mode never mutates the shared onboarding account.
    skip: (cfg) => cfg.remote,
    async run(ctx) {
      const { page, cfg, project } = ctx;
      await login(page, onboardingEmailFor(cfg, project), cfg.onboarding.password);
      await page.waitForURL(/\/onboarding/);
      const card = page.locator("main, body").first();

      // Step 1: property. Company reveals the VAT field.
      await page.getByRole("heading", { name: "Add your first property" }).waitFor();
      await page.getByRole("button", { name: "Company", exact: true }).click();
      await sweep(ctx, card, "onboarding step 1 (property)", { min: 5 });
      await page.getByRole("button", { name: "Individual", exact: true }).click();
      await page.getByPlaceholder("Street", { exact: true }).fill("Teststraat");
      await page.getByPlaceholder("Number", { exact: true }).fill("1");
      await page.getByPlaceholder("1000", { exact: true }).fill("1000");
      await page.getByPlaceholder("City", { exact: true }).fill("Brussel");
      await next(page, "Add a tenant");

      // Step 2: tenant, the original report. Type a name letter by letter
      // first, exactly like the user did.
      await typeAndAssertFocus(
        page,
        page.getByPlaceholder("First name", { exact: true }),
        "Jeroen",
        "onboarding step 2 (tenant)"
      );
      await sweep(ctx, card, "onboarding step 2 (tenant)", { min: 3 });
      await page.getByPlaceholder("First name", { exact: true }).fill("Jeroen");
      await page.getByPlaceholder("Last name", { exact: true }).fill("Test");
      await page.getByPlaceholder("Email", { exact: true }).fill("jeroen.tenant@e2e.local");
      await next(page, "Create a lease");

      // Step 3: lease. Pick the property and tenant created above.
      const selects = page.locator("select");
      await selects.nth(0).selectOption({ index: 1 });
      if ((await selects.count()) > 2) await selects.nth(1).selectOption({ index: 1 });
      await sweep(ctx, card, "onboarding step 3 (lease)", { min: 2 });
      const date = page.getByPlaceholder(/dd\/mm\/yyyy|mm\/dd\/yyyy|yyyy/i).first();
      await date.fill("");
      await date.pressSequentially("01/01/2026");
      await page.getByPlaceholder("750.00").fill("850");
      await next(page, "Set up payment collection");

      // Step 4: payment collection has buttons only.
      await sweep(ctx, card, "onboarding step 4 (payment)", { min: 0 });
      await page.getByRole("button", { name: "Finish Setup" }).click();
      await page.getByText("You're all set!").waitFor();
      await page.getByRole("button", { name: "Go to Dashboard" }).click();
      // Until the session cookie knew onboarding was done, the middleware
      // bounced this navigation straight back to /onboarding.
      await page.waitForURL(/\/properties/).catch(() => {
        throw new TestFailure(`"Go to Dashboard" did not leave onboarding (at ${page.url()})`);
      });
      await page
        .getByText("Teststraat 1")
        .filter({ visible: true })
        .first()
        .waitFor()
        .catch(() => {
          throw new TestFailure("the property from onboarding is not listed on /properties");
        });
      // A reload goes through the middleware again and must stay here too.
      await page.reload();
      assert(new URL(page.url()).pathname === "/properties", `reloading /properties ended on ${page.url()}`);
    },
  },
];
