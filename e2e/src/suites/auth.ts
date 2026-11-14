import type { TestCase } from "../lib/testing";
import { sweep } from "../lib/testing";
import { login, open } from "../lib/session";
import { assert } from "../lib/report";

/** Pages around signing in. */
export const authTests: TestCase[] = [
  {
    name: "focus: login, register and forgot-password forms",
    async run(ctx) {
      const { page } = ctx;
      await open(page, "/login");
      await sweep(ctx, page.locator("form").first(), "login", { min: 2 });

      await page.getByRole("button", { name: "Don't have an account?" }).click();
      await sweep(ctx, page.locator("form").first(), "register", { min: 3 });

      await page.getByRole("button", { name: "Back to sign in" }).click();
      await page.getByRole("button", { name: "Forgot password?" }).click();
      await sweep(ctx, page.locator("form").first(), "forgot password", { min: 1 });
    },
  },
  {
    name: "focus: invitation accept page",
    async run(ctx) {
      const { page, cfg } = ctx;
      // Signed out, the page sends you to the login form first.
      await open(page, "/invite/accept?token=00000000-0000-0000-0000-000000000000");
      assert(new URL(page.url()).pathname === "/login", `expected a redirect to /login, got ${page.url()}`);
      // Signed in it only has accept/decline buttons; sweep in case fields appear.
      await login(page, cfg.landlord.email, cfg.landlord.password);
      await open(page, "/invite/accept?token=00000000-0000-0000-0000-000000000000");
      await sweep(ctx, page.locator("body"), "invite accept", { min: 0 });
    },
  },
];
