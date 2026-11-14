---
quick_id: 261114-gcx
type: quick
autonomous: true
---

# Quick Task 261114-gcx: GoCardless direct debit per landlord on hosted rentular.com (no shared creditor)

## Finding (verified 2026-11-14)

apps/api/src/lib/gocardless.ts builds one client from `GOCARDLESS_ACCESS_TOKEN` and `getCreditorInfo()` does `creditors.list({})` and takes `[0]`. Customers, billing requests/mandates and payments are all created with that one instance-wide token. On a self-hosted single-landlord install that is correct. On hosted rentular.com it would collect every landlord's tenants' rent into ONE GoCardless creditor account (Rentular's), which is wrong and would make Rentular handle third-party funds. Prod today: GOCARDLESS_* not set on m1, 0 mandates, 0 GoCardless customers, 0 GoCardless payments, so nothing to migrate. RENTULAR_INSTANCE=hosted is set on m1 (from 261109-ebk).

## Goal

- Self-hosted (`RENTULAR_INSTANCE` not hosted): unchanged behaviour with the env token (one landlord, one creditor), but make it explicit.
- Hosted: each landlord connects THEIR OWN GoCardless account via GoCardless's partner OAuth ("GoCardless Connect" / partner integration: authorize at connect.gocardless.com with client_id, redirect_uri, scope read_write, initial_view, then exchange the code at the token endpoint for an access_token and organisation_id; check the current GoCardless partner docs for exact URLs, sandbox vs live hosts, and scopes; if offline, implement from the documented flow and mark unverified parts in the SUMMARY). Store the landlord's access token encrypted (lib/encryption.ts) with organisation_id and creditor id. Every GoCardless call for a lease uses the landlord's token (owner of the property); the instance env token is NEVER used on hosted (fail closed with a clear error and a UI prompt to connect GoCardless).
- Partner app credentials via env: `GOCARDLESS_PARTNER_CLIENT_ID`, `GOCARDLESS_PARTNER_CLIENT_SECRET`, `GOCARDLESS_PARTNER_ENVIRONMENT` (sandbox|live), redirect `${public URL}/api/v1/gocardless/connect/callback`. Without them on hosted, direct debit is simply unavailable (UI says so), never falls back to the shared token.
- Optional partner app fee: leave at zero, add a commented hook (`app_fee`) only, no charging.

## Tasks

1. Schema: table `gocardless_connections` (id, owner_id unique, organisation_id, creditor_id, access_token_encrypted/iv/auth_tag, environment, scheme, status active|revoked|error, connected_at, last_error, updated_at). Prod DDL to `.planning/quick/261114-gcx-gocardless-per-landlord/prod-ddl.sql` (additive). Never run db:generate.
2. lib/gocardless.ts: replace the module-level single client with `getGoCardlessClientFor({ ownerId })` that resolves: hosted -> the owner's connection (error `GOCARDLESS_NOT_CONNECTED` if none); self-hosted -> env token. `getCreditorInfo({ ownerId })` returns the creditor of THAT client and, if several creditors exist on a self-hosted token, the one marked in env `GOCARDLESS_CREDITOR_ID` or the first with a clear log line. Thread ownerId through every caller (mandate setup / billing request flow, payment creation, retries, cancellations, refunds, mandate status checks, workers).
3. Routes: GET /gocardless/connect (start OAuth, signed state bound to the user via lib/bankOAuthState.ts pattern), GET /gocardless/connect/callback (exchange, fetch creditor, store), POST /gocardless/disconnect (revoke at GoCardless if the API supports it, mark revoked), GET /gocardless/status (connected?, organisation, creditor name, environment; never the token). Owner/co_owner only.
4. Webhooks: GoCardless partner webhooks carry `links.organisation`; route each event to the connection with that organisation_id and verify the signature with the partner app's webhook secret (`GOCARDLESS_PARTNER_WEBHOOK_SECRET`) on hosted, the existing secret on self-hosted. Events for an unknown organisation are acknowledged and logged, never applied to another landlord's data. Add a test that an event for organisation A cannot touch landlord B's mandates/payments.
5. Web: Settings (or the bank/payments settings page where SEPA direct debit is configured) gets "Domiciliëring via GoCardless": connect button, status, disconnect; the tenant mandate setup UI (MandateSetupModal) checks the landlord is connected and otherwise explains how. EN/NL/FR/DE, human tone.
6. Docs: SELF-HOSTING.md (env token path for self-hosters; partner path is for multi-landlord installs), .env templates, and a short note in the pricing/feature copy only if it currently promises direct debit on hosted without mentioning that the landlord needs their own GoCardless account (check and adjust).

## Tests

- Hosted: a lease of landlord A uses A's token and A's creditor; landlord B without a connection gets GOCARDLESS_NOT_CONNECTED; the env token is never read on hosted (assert with a spy).
- Self-hosted: env token path still works, creditor selection with GOCARDLESS_CREDITOR_ID.
- OAuth state tampering rejected; token never returned by any API response; webhook organisation isolation.

## Checks

- api vitest green; apps/api and apps/web `npx tsc --noEmit -p .`; apps/web `pnpm build` (placeholder DB_PASSWORD/AUTH_SECRET if needed).
- No em-dashes or en-dashes; no Co-Authored-By lines; all UI strings EN/NL/FR/DE. Never deploy, never touch prod, never call GoCardless live or sandbox APIs, never run db:generate. Do not edit apps/api/src/services/indexationCalc.ts or the indexation constants (another task owns them).
