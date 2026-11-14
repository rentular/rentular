import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const PROJECT_NAMES = [
  "chromium-desktop",
  "chromium-mobile",
  "webkit-desktop",
  "webkit-mobile",
] as const;
export type ProjectName = (typeof PROJECT_NAMES)[number];

export interface E2eConfig {
  baseUrl: string;
  apiUrl: string;
  /** True when testing an already deployed instance instead of the local stack. */
  remote: boolean;
  landlord: { email: string; password: string };
  onboarding: { email: string; password: string };
  db: { host: string; port: number; user: string; password: string; name: string };
  mailUiUrl: string;
  artifactsDir: string;
  projects: ProjectName[];
  headed: boolean;
}

/** Hosts the suite never runs against. Production holds real landlords. */
const FORBIDDEN_HOSTS = /(^|\.)rentular\.com$/i;

function loadEnvFile(): void {
  const file = process.env.E2E_ENV_FILE || path.join(E2E_DIR, ".env.e2e.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set. Run e2e/run-local.sh or e2e/scripts/init-env.sh first.`);
  return v;
}

export function assertAllowedUrl(url: string): void {
  const host = new URL(url).hostname;
  if (FORBIDDEN_HOSTS.test(host)) {
    throw new Error(
      `Refusing to run browser tests against ${host}. Use the local stack or a staging instance.`
    );
  }
}

let cached: E2eConfig | undefined;

export function loadConfig(): E2eConfig {
  if (cached) return cached;
  loadEnvFile();
  // run-remote.sh sets E2E_REMOTE=1: no seeding, no database access, and the
  // onboarding flow is skipped because it would change the shared account.
  const remote = process.env.E2E_REMOTE === "1";
  const webPort = process.env.E2E_WEB_PORT || "3410";
  const apiPort = process.env.E2E_API_PORT || "4410";
  const baseUrl = (process.env.E2E_BASE_URL || `http://localhost:${webPort}`).replace(/\/$/, "");
  const apiUrl = (process.env.E2E_API_URL || `http://localhost:${apiPort}/api/v1`).replace(/\/$/, "");
  assertAllowedUrl(baseUrl);
  assertAllowedUrl(apiUrl);

  const requested = (process.env.E2E_PROJECTS || PROJECT_NAMES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((p) => !(PROJECT_NAMES as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`Unknown E2E_PROJECTS entries: ${unknown.join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  cached = {
    baseUrl,
    apiUrl,
    remote,
    landlord: {
      email: process.env.E2E_LANDLORD_EMAIL || "landlord@e2e.local",
      password: required("E2E_LANDLORD_PASSWORD"),
    },
    onboarding: {
      email: process.env.E2E_ONBOARDING_EMAIL || "onboarding@e2e.local",
      password: required("E2E_ONBOARDING_PASSWORD"),
    },
    db: {
      host: process.env.E2E_DB_HOST || "127.0.0.1",
      port: Number(process.env.E2E_DB_PORT || 33306),
      user: process.env.E2E_DB_USER || "rentular_e2e",
      password: process.env.E2E_DB_PASSWORD || "",
      name: process.env.E2E_DB_NAME || "rentular_e2e",
    },
    mailUiUrl: process.env.E2E_MAIL_UI_URL || `http://localhost:${process.env.E2E_MAIL_UI_PORT || 38025}`,
    artifactsDir: process.env.E2E_ARTIFACTS_DIR || path.join(E2E_DIR, "artifacts", stamp),
    projects: requested as ProjectName[],
    headed: process.env.E2E_HEADED === "1",
  };
  return cached;
}

/** Each browser project gets its own fresh onboarding account. */
export function onboardingEmailFor(cfg: E2eConfig, project: string): string {
  const [local, domain] = cfg.onboarding.email.split("@");
  return `${local}+${project}@${domain}`;
}
