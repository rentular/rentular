import type { BrowserContext, Page } from "playwright";
import { assertAllowedUrl, loadConfig } from "./config";
import { TestFailure } from "./report";

/** Signs in through the real login page. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  const cfg = loadConfig();
  assertAllowedUrl(cfg.baseUrl);
  await page.goto(`${cfg.baseUrl}/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }).catch(() => {
      throw new TestFailure(`login as ${email} did not leave the login page`);
    }),
    page.locator('button[type="submit"]').click(),
  ]);
}

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
const landlordCookies = new Map<string, Cookies>();

/**
 * Signs in as the seeded landlord. The first test per browser project goes
 * through the login page; later tests reuse its session cookies.
 */
export async function loginLandlord(page: Page, project: string): Promise<void> {
  const cfg = loadConfig();
  const cached = landlordCookies.get(project);
  if (cached) {
    await page.context().addCookies(cached);
    return;
  }
  await login(page, cfg.landlord.email, cfg.landlord.password);
  landlordCookies.set(project, await page.context().cookies());
}

/** Navigates to an app path and waits until the client has settled. */
export async function open(page: Page, pathname: string): Promise<void> {
  const cfg = loadConfig();
  await page.goto(`${cfg.baseUrl}${pathname}`);
  // Pages poll some endpoints, so do not wait forever for a quiet network.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}
