---
quick_id: 261114-gcx
status: complete
completed: 2026-11-14
branch: worktree-agent-aeb545952a5ecdb38
commits:
  - ac01538 feat(db): gocardless_connections table for per-landlord GoCardless accounts
  - 31a256b feat(api): GoCardless client per landlord, hosted installs never use the instance token
  - 3706109 feat(api): GoCardless connect, callback, disconnect and status per landlord
  - 8ed9988 feat(api): route GoCardless webhooks to the landlord of the event's organisation
  - e70eba3 test(api): per-landlord GoCardless tokens, OAuth state, token secrecy and webhook isolation
  - 76e5a07 feat(web): connect your own GoCardless account in Settings, mandate setup explains when it is missing
  - d736e50 docs: GoCardless per landlord (partner app) vs one instance token, env vars and copy
  - a2805fd feat(api): revoke the GoCardless token on disconnect, handle access_token_revoked
ddl_first: true
---

# Quick 261114-gcx: GoCardless direct debit per landlord on hosted rentular.com

On hosted rentular.com every landlord now connects their own GoCardless account through Rentular's GoCardless partner app, and every mandate, payment, retry, cancellation and mandate lookup for a lease runs with the token of that lease's property owner. The instance token `GOCARDLESS_ACCESS_TOKEN` is never read on a hosted install. Self-hosted installs keep working with the instance token, now with `GOCARDLESS_CREDITOR_ID` to pick a creditor.

## What was built

**Storage** (`packages/db/src/schema/gocardlessConnections.ts`, `apps/api/src/lib/gocardlessConnections.ts`)
- Table `gocardless_connections`: one row per landlord (owner_id unique), organisation_id (indexed), creditor id and name, access token AES-256-GCM encrypted (lib/encryption.ts), environment, scheme, status active|revoked|error, connected_at, last_error, updated_at.
- The API only returns `toConnectionStatus()` (connected, status, organisation, creditor, environment, scheme, dates, last error). Disconnect wipes the token and keeps the organisation id, so late webhooks are still recognised.

**Client resolution** (`apps/api/src/lib/gocardless.ts`)
- `getGoCardlessClientFor({ ownerId })`. Hosted: the owner's active connection, or `GOCARDLESS_NOT_CONNECTED`. Hosted without partner credentials: `GOCARDLESS_PARTNER_NOT_CONFIGURED` (fails closed, no fallback). Self-hosted: env token, or `GOCARDLESS_NOT_CONFIGURED`.
- Every operation takes a scope first: `createCustomer`, `createMandateSetupFlow`, `getMandate`, `cancelMandate`, `createPayment`, `retryPayment`, `cancelPayment`, `listPayments`, `getCreditorInfo`.
- `getCreditorInfo` uses the connection's stored creditor (hosted) or `GOCARDLESS_CREDITOR_ID` (self-hosted), else the first creditor with a log line when there are several.
- `app_fee` is only a comment in `createPayment`. Nothing is charged.
- Callers: `routes/payments.ts` (collect, retry, cancel) and `routes/gocardless.ts`. No worker calls GoCardless (checked: only those two route files import the client).

**Partner OAuth** (`apps/api/src/lib/gocardlessPartner.ts`)
- `GOCARDLESS_PARTNER_CLIENT_ID`, `GOCARDLESS_PARTNER_CLIENT_SECRET`, `GOCARDLESS_PARTNER_ENVIRONMENT` (sandbox|live), optional `GOCARDLESS_PARTNER_REDIRECT_URL`. The default redirect is `${WEB_URL}/api/v1/gocardless/connect/callback`.
- Authorize: `https://connect[-sandbox].gocardless.com/oauth/authorize` with response_type=code, client_id, scope=read_write, redirect_uri, state, initial_view (login or signup), prefill[email], language.
- Token: POST form-encoded to `/oauth/access_token` (grant_type=authorization_code, code, redirect_uri, client_id, client_secret), and it reads access_token + organisation_id. Errors carry only the OAuth error code and description, never the secret.

**Routes** (`apps/api/src/routes/gocardless.ts`)
- `GET /gocardless/status`: the user's setup (mode partner|instance, partnerConfigured, canConnect, connection). With `?leaseId=` it says whether the lease's landlord can collect (manager+ on the property). The masked instance token is no longer returned.
- `GET /gocardless/connect`: hosted only. Returns `{ url }` with a state signed through `lib/bankOAuthState.ts` (provider `gocardless`, bound to the user, 10 minutes, nonce).
- `GET /gocardless/connect/callback`: skips the session check (index.ts) and requires a valid state for the `gocardless` flow. It exchanges the code, reads the creditor with the new token, stores the connection, and redirects to `/settings?tab=gocardless&gocardless=connected|error&reason=...`.
- `POST /gocardless/disconnect`: revokes the token at GoCardless first (`POST {connect host}/oauth/revoke` with form fields token, client_id, client_secret; best effort, GoCardless always answers 200 with no body). Then it marks the connection revoked and wipes the token locally, even when the revoke call failed.
- Revoked tokens: when any call made with a landlord's token gets a 401 with reason `access_token_revoked` (the landlord removed Rentular at GoCardless, or a newer token replaced it), the connection is marked revoked and the call fails with `GOCARDLESS_NOT_CONNECTED`. Settings then shows "GoCardless no longer accepts Rentular's access..." with the connect button, and the mandate dialog asks the landlord to connect again. The client wrapper in `lib/gocardless.ts` does this for every resource method.
- Reconnect: GoCardless issues a new token and disables the old one, so `saveConnection` always overwrites the owner's row (one row per owner), revoked or not.
- Connect is for owners and co-owners, plus new accounts without any property yet. Pure managers, accountants and viewers get 403.
- The Ponto callback now rejects a state minted for another flow.

**Webhooks** (`apps/api/src/services/gocardlessWebhook.ts`, `routes/webhooks.ts`)
- Hosted installs verify with `GOCARDLESS_PARTNER_WEBHOOK_SECRET`. Self-hosted installs keep `GOCARDLESS_WEBHOOK_SECRET`.
- Hosted: `links.organisation` is mapped to the connection's owner, and every lookup and update (payment, lease, tenant, cascade cancel) joins `properties.owner_id` to that owner. An event without an organisation, or for an organisation nobody connected, is stored in `webhook_events` as `skipped` with the reason and touches nothing.
- An `organisations.disconnected` handler revokes that landlord's connection. GoCardless does not document this event, so it is only a harmless extra. The documented signal is the 401 `access_token_revoked` described above.

**Web**
- New `components/GoCardlessConnectionCard.tsx` in Settings, GoCardless tab ("Domiciliëring via GoCardless"). It has Connect, "Create a GoCardless account" (initial_view=signup), status, organisation, creditor, environment, "connected on", and Disconnect with a confirm. A toast shows the outcome after the redirect. `?tab=gocardless` opens the tab. The creditor card only shows once GoCardless is ready.
- `MandateSetupModal` checks `/gocardless/status?leaseId=` first. When collection is not possible it explains why: connect your own account (with a "Go to Settings" button), ask the owner, not available yet, or the server token is missing on a self-hosted install.
- All new strings are in EN/NL/FR/DE.

**Docs:** SELF-HOSTING.md has a new "GoCardless direct debit" section: the single-landlord token path, and the partner path for multi-landlord installs. Two new rows were added to the webhooks/redirect table. `.env.example` and `.env.production.example` have the partner variables and `GOCARDLESS_CREDITOR_ID`. The landing/marketing SEPA copy and the support chat answer now say the landlord connects their own GoCardless account.

## Checks (actually run)

- `apps/api`: `npx vitest run` (rerun after the follow-up): 82 files, 766 tests passed. 5 of the files are new, with 39 new tests. The follow-up added: revoke posts token, client_id and client_secret to /oauth/revoke and returns false on a network error. Disconnect revokes with the stored token, and still wipes locally when the revoke fails. A 401 access_token_revoked marks the connection revoked and returns GOCARDLESS_NOT_CONNECTED, while other errors pass through untouched. A reconnect overwrites the owner's row (`lib/__tests__/gocardlessConnections.test.ts`).
- The first round of tests:
  - `lib/__tests__/gocardless.test.ts`: on hosted, A's lease uses TOKEN-A and creditor CR-A2. B gets GOCARDLESS_NOT_CONNECTED. A process.env proxy spy counts 0 reads of GOCARDLESS_ACCESS_TOKEN on hosted. Without partner credentials the call fails closed. Self-hosted uses the env token, GOCARDLESS_CREDITOR_ID picks the creditor, and with several creditors the first is used with a log line.
  - `lib/__tests__/gocardlessPartner.test.ts`: authorize url, form-encoded exchange, the secret does not appear in the error, a missing organisation_id is rejected.
  - `routes/__tests__/gocardless.test.ts`: the callback stores the right owner. A tampered state is rejected, and so is a state from another flow. The landlord token, ciphertext, env token and client secret are absent from the callback, status, connect and disconnect responses. Hosted webhooks only verify with the partner secret, self-hosted ones with the instance secret.
  - `services/__tests__/gocardlessWebhook.test.ts`: an event for organisation A cannot touch landlord B's payment, lease, tenant or pending payments, even when the GoCardless ids collide. An unknown organisation is skipped with no change. An event with no organisation is skipped on hosted. Duplicates are skipped. `disconnected` revokes only that landlord.
- `apps/api` and `apps/web`: `npx tsc --noEmit -p .`: clean.
- `apps/web`: `pnpm build` with placeholder DB_PASSWORD/AUTH_SECRET: exit 0, `/settings` built.
- No dash characters in the diff. No Co-Authored-By lines.
- `apps/web`: `pnpm build` again after the follow-up: exit 0. The standalone-copy warning was there before this work.
- **Checked against the docs, not against a live API:** the coordinator compared the code with the GoCardless OAuth reference (https://docs.gocardless.com/docs/api-reference/oauth-reference.md). The authorize and access_token hosts, the parameters (response_type=code, client_id, scope read_write, redirect_uri, state, initial_view signup|login, prefill[...]), the token response fields and `/oauth/revoke` match. No GoCardless API was called, neither live nor sandbox. Still open: the `links.organisation` field on partner webhook events was not part of that check. Confirm it with the first sandbox webhook.

## Deploy order (DDL FIRST)

1. Back up the `rentular` database on m1.
2. Apply `.planning/quick/261114-gcx-gocardless-per-landlord/prod-ddl.sql`. It is additive: one new table. On a hosted install the API reads this table for every GoCardless call and every webhook, so the DDL must go in before the code.
3. The m1 env already has `RENTULAR_INSTANCE=hosted`. Do NOT set `GOCARDLESS_ACCESS_TOKEN` there (it would be ignored anyway). Until the partner variables below are set, the GoCardless tab says direct debit is not available yet, and the mandate dialog says the same. That is the intended state for today (0 mandates, 0 GoCardless payments on prod).
4. Merge the branch, build web, `pm2 restart` api and web.
5. Smoke test: `GET /api/v1/gocardless/status` with a session returns `mode: "partner"`, `partnerConfigured: false` and no token field.

## What the owner must do at GoCardless (to switch direct debit on for hosted)

1. Ask GoCardless for a **partner account** (partners or "build an integration" in their developer docs). Start in the **sandbox**: create a sandbox account at manage-sandbox.gocardless.com.
2. In the partner dashboard, **register an app** (OAuth client) named "Rentular".
   - Redirect URI: `https://www.rentular.com/api/v1/gocardless/connect/callback` (exactly this value; set `GOCARDLESS_PARTNER_REDIRECT_URL` only if it must differ).
   - Webhook URL: `https://www.rentular.com/api/v1/webhooks/gocardless`. Note the webhook secret.
   - Leave any app fee at zero.
3. On m1, add to the API env: `GOCARDLESS_PARTNER_CLIENT_ID`, `GOCARDLESS_PARTNER_CLIENT_SECRET`, `GOCARDLESS_PARTNER_ENVIRONMENT=sandbox`, `GOCARDLESS_PARTNER_WEBHOOK_SECRET`. Then `pm2 restart` the API.
4. Test with your own landlord account: Settings, GoCardless tab, "GoCardless koppelen". Log in at a sandbox merchant account and approve. You should land back on the tab with "Gekoppeld", your organisation id and creditor name. Then set up a mandate on a test lease and send a webhook test from the dashboard (look for `[Webhook] Processing ...` in the API log).
5. When this works, have the app approved for **live**, create the live app with the same URLs, swap the four variables to the live values with `GOCARDLESS_PARTNER_ENVIRONMENT=live`, and restart. Landlords connected in sandbox have to connect again in live.

## Deviations from Plan

1. **[Rule 2 - Security] Fixed IDOR on mandate read, mandate cancel and customer creation.** `GET /gocardless/mandates/:id` and `POST /mandates/:id/cancel` had no access check. `POST /customers` updated any tenant id. They now require access to a lease using the mandate (viewer for read, manager for cancel) or ownership of the tenant, and the landlord's token is used. `/mandates/complete` now checks access before calling GoCardless. Cost if wrong: a manager without lease access to an orphaned mandate (one only on a tenant row) gets 404.
2. **[Rule 2] The Ponto callback rejects states minted for another flow.** This stops a GoCardless or Enable Banking state from being replayed at the Ponto callback. Cost if wrong: none for normal Ponto flows (their states carry no provider or "ponto").
3. **[Rule 2] `GET /gocardless/status` no longer returns the masked instance token**, on self-hosted either. The plan says never the token. Cost if wrong: self-hosters no longer see the first 8 characters of their token in the UI.
4. **`GET /gocardless/connect` returns `{ url }` instead of redirecting.** The browser calls the API with fetch and credentials and then navigates, like the Enable Banking start. Cost if wrong: none functionally.
5. **Connect is allowed for owners, co-owners and new accounts with no properties.** The connection is personal: it is only used for properties the user owns. Cost if wrong: a pure manager who later becomes an owner has to come back to connect.
6. **Webhook processing moved into `services/gocardlessWebhook.ts` behind a store interface**, so the isolation test runs without a database. Cost if wrong: the DB store's owner filters (joins on properties.owner_id) are covered by type checks and review, not by a DB test.
7. **Accents fixed in two existing FR/DE feature strings I changed** ("à poursuivre", "über", "Überweisungen"). Cost if wrong: none.
8. The old `settings.goCardlessConnectionStatus/ApiToken/EnvNote/...` i18n keys are now unused and left in place.

## Assumption Drift (advisory)

- The plan expected workers to call GoCardless (retries, mandate status checks). None do: the only callers are `routes/payments.ts` and `routes/gocardless.ts`. Cost if wrong: none, both are scoped.

## Known Stubs

None. Direct debit is unavailable on hosted until the partner env vars are set, and the UI says so. That is intended, not a stub.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: unauthenticated-callback | apps/api/src/index.ts, routes/gocardless.ts | `/gocardless/connect/callback` skips the session check. The HS256 state (10 min, nonce, owner, provider=gocardless) protects it. |
| threat_flag: secret-at-rest | lib/gocardlessConnections.ts | Each landlord's GoCardless access token is stored AES-256-GCM encrypted under AUTH_SECRET. It is never returned or logged. Disconnect wipes it. |
| threat_flag: outbound-third-party | lib/gocardlessPartner.ts | New outbound POSTs to connect[-sandbox].gocardless.com (/oauth/access_token and /oauth/revoke), carrying the partner client secret. |
| threat_flag: webhook-routing | services/gocardlessWebhook.ts | On hosted, webhook events are scoped by `links.organisation`. Unknown organisations are skipped. |

## Self-Check: PASSED

- Files exist: packages/db/src/schema/gocardlessConnections.ts, apps/api/src/lib/gocardlessConnections.ts, apps/api/src/lib/gocardlessPartner.ts, apps/api/src/services/gocardlessWebhook.ts, apps/web/components/GoCardlessConnectionCard.tsx, the 4 test files, prod-ddl.sql.
- Commits ac01538, 31a256b, 3706109, 8ed9988, e70eba3, 76e5a07, d736e50 and a2805fd are on branch worktree-agent-aeb545952a5ecdb38.
- SUMMARY, prod-ddl.sql, STATE.md and PLAN.md are not committed, as instructed.
