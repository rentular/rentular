---
quick_id: 261114-e2e
status: complete
subsystem: testing, web
tags: [e2e, playwright, focus, onboarding, webkit, ops]
key-files:
  created:
    - e2e/package.json
    - e2e/run-local.sh
    - e2e/run-compose.sh
    - e2e/run-remote.sh
    - e2e/docker-compose.deps.yml
    - e2e/docker-compose.e2e.yml
    - e2e/Dockerfile
    - e2e/proxy/Caddyfile
    - e2e/scripts/init-env.sh
    - e2e/scripts/container-run.sh
    - e2e/ops/nightly.sh
    - e2e/ops/rentular-e2e.service
    - e2e/ops/rentular-e2e.timer
    - e2e/.env.e2e.example
    - e2e/src/seed.ts
    - e2e/src/run.ts
    - e2e/src/lib/{config,focus,report,session,testing}.ts
    - e2e/src/suites/{auth,onboarding,dashboardSweep,smoke}.ts
    - docs/TESTING-OPERATIONS.md
  modified:
    - apps/web/components/ApiTokensCard.tsx
    - apps/web/lib/auth.ts
    - apps/web/app/onboarding/page.tsx
    - apps/web/components/MobileNav.tsx
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - .gitignore
    - .dockerignore
    - README.md
    - CONTRIBUTING.md
completed: 2026-11-14
---

# Quick Task 261114-e2e: browser focus tests, local test accounts, ops testing guide

The original onboarding focus bug (0eae15c) is now verified fixed by typing
into the field one key at a time in Chromium and WebKit, on desktop and phone
viewports. The sweep checks 120 fields per browser (480 per run) and found
three more real bugs, all fixed. None of the three was a focus bug. The suite
also runs in Linux containers for the linuxbe-cluster.

## What was built

- **`e2e/` workspace package** on the `playwright` 1.58.2 that was already in
  the lockfile. `pnpm install --offline` added it, nothing new was downloaded.
  The runner is written on playwright directly (no @playwright/test), with
  its own report: `summary.txt`, `results.json`, `junit.xml`, and a
  screenshot plus trace for every failure.
- **`typeAndAssertFocus`** (e2e/src/lib/focus.ts): clicks the field, clears
  it, types through the real keyboard one key at a time and, after every key,
  checks that `document.activeElement` is the same DOM node, using a marker
  attribute. A remounted input is a new node without the marker. The error
  names the page, field label, character index and where focus went. A
  value that does not match what was typed is a non-fatal note (none came up).
- **Seeded test accounts** (e2e/src/seed.ts, bcrypt cost 12 like the app):
  `landlord@e2e.local` (onboarding done, property "Teststraat 1", tenant
  Tess Tester, active contract, 4 payments) and one fresh onboarding account
  per browser project (`onboarding+<project>@e2e.local`), reset on reseed.
  Passwords are generated into the gitignored `e2e/.env.e2e.local` (chmod
  600). They are never printed. `e2e/.env.e2e.example` holds placeholders.
- **`e2e/run-local.sh`**: MariaDB, Redis and Mailpit in Docker on loopback
  ports (33306/36379/31025/38025) with tmpfs. Then `drizzle-kit push --force`
  (never db:generate), seed, a production web build, the API (tsx) and the
  standalone web server on :4410/:3410 under `env -i`, so only e2e settings
  reach them. Then the tests run and a trap tears everything down, also on
  failure and Ctrl-C.
- **Containerised Linux runner** (per the owner's change for the
  linuxbe-cluster): `e2e/Dockerfile` on `mcr.microsoft.com/playwright:v1.58.2-noble`,
  and `e2e/docker-compose.e2e.yml` with MariaDB, Redis, Mailpit, the
  production API and web Dockerfiles, a Caddy proxy that gives one origin
  (like production), and the runner. They share an internal network with no
  published ports, tmpfs data and per-service CPU and memory limits.
  `e2e/run-compose.sh` writes a dated report folder, prunes folders older
  than 14 days and always runs `down -v`. It also supports
  `COMPOSE="podman compose"`.
- **Remote mode** (`e2e/run-remote.sh`, `E2E_REMOTE=1`): tests an existing
  staging instance through `E2E_BASE_URL`/`E2E_API_URL` and credentials from
  the env file. Data-creating tests are skipped there. Any `*.rentular.com`
  host is refused in code (`assertAllowedUrl`), and nothing defaults to
  production.
- **Ops**: `e2e/ops/nightly.sh` (skip file or skip command, git update, low
  priority run, failure mail via `mail`/`sendmail`, exit code passed on) plus
  a systemd service and a 03:30 timer.
- **docs/TESTING-OPERATIONS.md**, written for the operations manager: an
  unprivileged Debian LXC with nesting, 2 vCPU/4 GB/20 GB, low CPU units, kept
  outside the lab pools and off participant networks. It covers setup,
  running, reading reports, the nightly timer, skipping during courses,
  alerting, Podman, remote mode, the weekly manual production checklist with
  their own test account, the "do not" list and how to report bugs. It is
  linked from README.md and CONTRIBUTING.md.

## Fields and pages swept (same set in every browser)

Projects: `chromium-desktop` (1366x900), `chromium-mobile` (Pixel 7, Android
like the Rentular app), `webkit-desktop` (1366x900) and `webkit-mobile`
(iPhone 13). 120 fields per project.

| Page / dialog | Fields typed into |
|---|---|
| login | Email address, Password |
| register | Email address, Password, Confirm password |
| forgot password | Email address |
| invite accept | none (accept/decline buttons only; signed-out redirect to /login checked) |
| onboarding step 1 (property, Company chosen) | VAT number, Street, Number, Postal code, City |
| onboarding step 2 (tenant, the reported bug) | First name ("Jeroen" typed first), Last name, Email, Phone |
| onboarding step 3 (lease) | Start date, Monthly rent |
| onboarding step 4 (payment) | none (buttons only) |
| properties add + edit | Property name, Street, Number, Box / Unit, Postal code, City, Cadastral reference, EPC score, EPC certificate number, EPC expiry date, Notes |
| property managers invite | Email address |
| tenants search | Search tenants |
| tenants add (with "Add account") + edit | First name, Last name, Email, Phone, National register number, IBAN fields, Notes |
| leases search | Search leases |
| contract add + edit (Lease registered switch flipped, indexation setup open) | Signing date, Start date, End date, Monthly rent, Monthly charges, Payment day, Deposit, Original contract rent, Base index, Last indexation date |
| contract communication page + reminder mute dialog | Date, Note |
| payments: record payment / add cost / rent-free / deduction / ignore reason | Amount, Payment date, Reference, Notes / Description, Amount, Date, Reference, Notes / Start, End, Reason, Notes / Deduction amount, Start, Reason, Notes / Reason |
| settings: Payment Follow-up | Test SMS number, the three reminder day numbers, three template subject + body pairs |
| settings: Bank Accounts (add form) | Label, IBAN, Account holder |
| settings: Profile | WhatsApp number |
| settings: API tokens | Name |
| settings: Landlord Reports, GoCardless | none typable (selects/buttons) |
| Enable Banking wizard | Application ID |
| mandates | search |
| maintenance add task | Task name, Interval, Last completed, Notes |
| import | Smovin email, Smovin password (never submitted) |
| communications, overview | none typable |

Skipped on purpose: read-only or disabled inputs (for example the indexation
"Reference month"), file inputs, and the sr-only native date inputs behind
the text date fields.

## Additional bugs found and fixed (one commit each)

1. **Settings crashed when opening the API tokens tab** (10cdc74). Radix
   Select throws on `<SelectItem value="">`, and the "No expiry" option used
   exactly that. The whole Settings page went blank. The value is now
   `"never"`, sent to the API as no expiry, the same as before.
2. **Finishing or skipping onboarding bounced the user back to the wizard**
   (3fee190). The middleware reads `onboardingComplete` from the JWT, but the
   JWT only read it at sign-in, so "Go to Dashboard", "Skip setup" and the
   page's own "already complete" redirect all went back to /onboarding until
   the user signed out and in again. The JWT callback now re-checks the
   database while the flag is false (it never queries again once true), and
   the onboarding page reads `/api/auth/session` (which reissues the cookie)
   before navigating. Verified: the test reaches /properties, sees the
   property and stays there after a reload.
3. **Phone menu: language switcher and sign out unreachable on iPhone**
   (de4b5e8). In an iPhone 13 Safari viewport the nav list filled the panel
   and the panel did not scroll. The list now scrolls (`min-h-0
   overflow-y-auto`) and the footer stays on screen.

No other focus-loss bug was found. A static check agreed: the only
components declared inside components are table `SortHeader`s and the
onboarding `StepIndicator`/`ImportedSummary`, and none of them contain
inputs. There are no unstable `key`s, and the `autoFocus` uses are
intentional (search popups).

## Regression proof for the original bug

`FormField` was moved back inside `OnboardingPage` in the working tree only
(the state before 0eae15c), the web app rebuilt, and the onboarding test run:

```
FAIL [chromium-desktop] onboarding: type into every step and finish setup  1.3s
     onboarding step 1 (property) > "VAT number" (input[text]): lost focus after typing character 1 ("B"); focus moved to <body> ...
FAIL [webkit-mobile] onboarding: type into every step and finish setup  1.5s
     (same message)
0 passed, 2 failed
```

The file was then restored with `git checkout -- apps/web/app/onboarding/page.tsx`.
With the fix in place the same test passes in all four projects.

## Run output (final local proof, `e2e/run-local.sh`, full build, all four projects)

```
[e2e] starting MariaDB, Redis and Mailpit
[e2e] creating the schema (drizzle-kit push)
[e2e] seeding test accounts
[e2e] building the web app (takes a few minutes)
[e2e] starting the API on http://localhost:4410
[e2e] starting the web app on http://localhost:3410
[e2e] API is up
[e2e] web app is up
[e2e] running browser tests
88 passed, 0 failed, 0 skipped, 480 fields typed into
[e2e] stack stopped; artifacts in e2e/artifacts/2026-11-14T19-15-11
```

That is 22 tests x 4 projects with exit code 0. Afterwards no rentular-e2e
containers and no API/web processes were left (checked with `docker ps` and
`pgrep`).

Other checks:
- `pnpm --filter @rentular/api test`: 77 files, 727 tests passed.
- `apps/web`: `npx tsc --noEmit -p .` clean (after the build had regenerated `.next/types`).
- `e2e`: `tsc --noEmit -p .` clean.

## Containerised runner (Linux images, run on this Mac's Docker)

`e2e/run-compose.sh` built all images (Playwright 1.58.2 noble runner, the
production API and web Dockerfiles) and ran the stack on the internal network:

- chromium-desktop: **22/22 passed** inside the containers.
- webkit-mobile: the first attempt failed at login because WebKit on Linux
  does not keep cookies for the single-label host `app`. After switching the
  stack to `rentular.test`: **22 passed, 0 failed, 0 skipped, 120 fields**,
  `run-compose.sh` exit 0, `down -v` left no containers, networks or volumes.
- chromium-mobile and webkit-desktop have not run in containers yet. They
  passed in the local run.

The runner fixes from these runs are in 83961de: corepack keeps pnpm in a
shared `COREPACK_HOME` and runs with the network off (the runner has no
internet), the report folder is chmod 777 for the runner's user id, a
missing report gives exit code 2, and the hostname is now dotted. On macOS,
report folders must be under a path that Docker Desktop shares
(`/private/tmp/...` was not). On Linux this does not apply. The three images
built here (about 4.8 GB) were removed afterwards because this Mac's disk is
nearly full. The pulled base images (playwright, redis, mailpit) were kept.

## What could not be covered

- **The linuxbe-cluster itself**: not touched, as instructed. The LXC,
  systemd timer, mail relay and skip-command setup are documented and
  shipped, but they have not run there.
- **Podman**: supported through `COMPOSE="podman compose"` but not run.
- **Remote mode** (`run-remote.sh`): not run, since no staging instance
  exists. The production refusal is enforced in code.
- **Custom message composer**: no such composer exists in the web app (no
  free-text message UI on communications or the contract page). The reminder
  mute note and the settings templates are the free-text fields, and both
  were swept.
- **Invite accept with a valid token**: the page only has accept/decline
  buttons, so there is nothing to type. Only the redirect and the empty sweep
  are checked.
- **Mailpit reminder mail check**: not automated. It is in the manual weekly
  checklist.
- **Real devices**: these are emulated viewports (Playwright WebKit is not
  iOS Safari and Pixel 7 emulation is not Android WebView). The manual
  checklist covers real phones and the Android app.

## Out-of-scope finding (not fixed)

`.env.example`, `.env.production.example`, `SELF-HOSTING.md` and
`docker-compose.prod.yml` describe `NEXT_PUBLIC_API_URL` as
`https://host/api/v1`, but all 139 call sites in apps/web append `/api/v1`
themselves (`${apiUrl}/api/v1/...`). With the documented value, requests go
to `/api/v1/api/v1/...` and return 404, unless a proxy rewrites them. The e2e
stacks use the bare origin. Worth checking how production is configured
before changing the docs.

## Deviations

- [Rule 1 - Bug] The three web fixes above. Cost if wrong: the
  onboarding fix touches the auth JWT callback, which adds one DB query per
  session read for users who have not finished onboarding yet.
- [Rule 3 - Blocking] The seed adds the `property_managers` owner row, which
  the API needs to list a property. WebKit build 2248, which matches
  playwright 1.58.2, was missing on this Mac. `playwright install webkit`
  downloaded it. That is a browser binary, not a package. The Mac's data
  volume was nearly full (10 to 18 GB free during the run).
- Owner change mid-task: containerised Linux runner, remote mode,
  cluster-focused ops guide. Done as described above.
- Phone projects: chromium-mobile uses a Pixel 7 profile instead of an
  iPhone 13 size, so the Android side is covered as well. webkit-mobile uses
  iPhone 13.
