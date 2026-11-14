---
quick_id: 261114-umk
status: complete
completed: 2026-11-14
subsystem: payments, landlord email link, MCP, contract history, web
tags: [manual-mark, undo, mark-month-paid, magic-link, mcp]
commits:
  - f5470b4 feat(261114-umk): table that records every manual paid mark with the row state before it
  - d0e9383 feat(261114-umk): record every manual paid mark and undo it exactly
  - f5e0bdd feat(261114-umk): the landlord email paid link records a mark and offers an undo
  - c227021 feat(261114-umk): undo a paid mark from the overview, the payments list, the contract page and the toast
  - e9bf1c2 feat(261114-umk): MCP unmark_rent_paid tool next to mark_rent_paid
  - 0931693 docs(261114-umk): the operations API run undoes its paid mark so the next run starts the same
  - 07834ac test(261114-umk): every mark branch undone to the exact prior state, refusals, permissions and the email link
key-files:
  created:
    - packages/db/src/schema/paymentManualMarks.ts
    - apps/api/src/services/manualMarks.ts
    - apps/api/src/services/manualMarksStore.ts
    - apps/api/src/services/__tests__/manualMarks.test.ts
    - apps/api/src/routes/__tests__/manualMarks.test.ts
    - apps/web/components/payments/ManualMarkUndo.tsx
    - .planning/quick/261114-umk-undo-mark-month-paid/prod-ddl.sql (not committed)
  modified:
    - packages/db/src/schema/index.ts
    - apps/api/src/routes/payments.ts
    - apps/api/src/routes/landlordActions.ts
    - apps/api/src/lib/landlordActionToken.ts
    - apps/api/src/lib/__tests__/landlordActionToken.test.ts
    - apps/api/src/services/landlordLateEmail.ts
    - apps/api/src/services/leaseCommunications.ts
    - apps/web/app/(dashboard)/overview/page.tsx
    - apps/web/app/(dashboard)/payments/page.tsx
    - apps/web/app/(dashboard)/leases/[id]/page.tsx
    - apps/web/messages/{en,nl,fr,de}/common.json
    - apps/mcp-server/src/tools/write.ts
    - apps/mcp-server/src/__tests__/tools.test.ts
    - apps/mcp-server/README.md
    - docs/TESTING-OPERATIONS.md
decisions:
  - Every manual mark writes one payment_manual_marks row with the row's fields before (null when the mark created the row) and right after the mark
  - Undo restores the before state with a direct update (paid -> pending is not a state machine transition); the mark row with undone_at/undone_by is the audit trail
  - Undo refuses (409) when the row is bank matched, has ledger allocations, is no longer paid, differs from the state the mark left, or (created row) got reminders recorded since
  - Only the latest active mark of a lease and month can be undone; by month the latest goes first
  - Source is api for a Bearer token, mcp when the MCP tool header is present, otherwise what the web app says (overview, or other for the payments list)
  - The email link undo is a second signed token naming the mark, expiring with the paid link, with a confirm step so link checkers never undo
metrics:
  completed: 2026-11-14
  commits: 7
---

# Quick 261114-umk: Undo for "mark month paid"

Every manual "paid" (overview, API, the landlord email link, MCP, and the payments list's "mark paid") is now recorded with the exact state of the payment row before and after, and can be undone exactly: the row goes back field by field, or is removed when the mark created it. The undo is in the web app on the overview's paid list, the payments list, the contract page and on the "Gemarkeerd als betaald" toast; in the API as `POST /payments/unmark-month-paid`; in MCP as `unmark_rent_paid`; and on the email link's confirmation page as "Toch niet betaald? Ongedaan maken".

## Required deploy order

1. Back up the prod database.
2. Apply `.planning/quick/261114-umk-undo-mark-month-paid/prod-ddl.sql` (one new table `payment_manual_marks`, nothing else changes). **DDL first**: every mark now writes a row there (inside the same transaction as the payment change), so marking paid would fail without the table. The lists (payments, overview paid list) fall back to "no undo" when the table cannot be read, but marking itself needs it.
3. Merge and deploy (build web, restart api and web). Never `db:generate`.
4. Marks made before the deploy have no mark row and cannot be undone from the app (as before, by hand in SQL).

Independent of the other open quick tasks.

## What changed

**Model (`services/manualMarks.ts`).** `markMonthPaid` keeps the three branches of the old route exactly (partial: open row takes the shortfall or a remainder row is inserted; no open row: a row is created paid; otherwise the open row becomes paid with the method) and records one mark per call. `markPaymentPaid` marks one specific row (payments list, email link). `undoMonthPaid` undoes the latest active mark of a lease and month, or a given `markId`. `undoBlocker` decides when a blind restore is unsafe. `describeMarks` builds what the web app shows, with `undoable` and the reason.

**Store (`services/manualMarksStore.ts`).** Drizzle implementation; the change of the payment row and the mark row happen in one transaction; the undo claims the mark with a conditional `undone_at IS NULL` update first, so two undos at once cannot both restore. Internal notes go to `communications` as `internal_note` / channel `internal` with `metadata.kind = "paid_mark"` (the 261109-agr mechanism, so they stay out of the 7-day counter).

**API.** `POST /payments/mark-month-paid` (unchanged answer plus `markId`), `POST /payments/:id/mark-paid` (now recorded, answer plus `markId`), `POST /payments/unmark-month-paid { leaseId, month | markId }` (manager+, write scope through the existing `/payments` guard; 404 for no access or no mark, 409 with `code` and an `error` that says what to do instead, 200 `already: true` when already undone), `GET /payments/manual-marks?leaseId=&month=`. `GET /payments` rows carry `manualMark`; dashboard paid items carry `manualMark`. Contract history entries carry `paidMark`.

**Email link.** "paid" goes through `markPaymentPaid` with the landlord as actor and source `magic_link` (the method is left alone, as before). The page offers the undo with a new `unpaid` token (names the mark, same expiry as the paid link). Opening it asks to confirm; `?confirm=1` undoes.

**Web.** `components/payments/ManualMarkUndo.tsx`: Undo button with confirm (looks disabled when the API would refuse; tapping it says why), "Handmatig gemarkeerd" badge, contract page card "Handmatig als betaald gemarkeerd" listing active marks. The toast after marking (overview and payments list) has an "Ongedaan maken" action for 10 seconds. The contract history shows "November 2026 handmatig als betaald gemarkeerd (contant) door Jasper Nuyens" and "Markering als betaald voor November 2026 ongedaan gemaakt door ..." in the viewer's language. EN/NL/FR/DE.

**MCP / docs.** `unmark_rent_paid` tool and README row. `docs/TESTING-OPERATIONS.md` Part 3: steps 8 and 9 (mark paid, nothing_owed, undo; what stays in the history).

## Places that set a payment paid (inventory)

| Place | Manual? | Now |
| --- | --- | --- |
| `POST /payments/mark-month-paid` (overview, API, MCP) | yes | through `markMonthPaid`, recorded |
| `POST /payments/:id/mark-paid` (payments list menu) | yes | through `markPaymentPaid`, recorded |
| `GET /landlord-action/:token` action `paid` | yes | through `markPaymentPaid`, recorded, undo link |
| `POST /payments/record` (record a payment with amount) | records money received, not a month mark | unchanged; delete/ignore as before |
| `POST /ledger/:leaseId/record-payment` | records money plus an allocation | unchanged; the ledger removes allocations |
| `PUT /leases/:id` priorPaymentsSettled closes the deposit row | side effect of a contract setting | unchanged |
| bank matching (`bankTransactions.ts`, `transactionMatcher.ts`, `reconciliationAssign.ts`), GoCardless webhooks | automatic | unchanged, excluded by design |

## Verification (run, observed)

- `apps/api npx vitest run`: 85 files, 850 tests passed. New: `services/__tests__/manualMarks.test.ts` (19), `routes/__tests__/manualMarks.test.ts` (22), 3 in `lib/__tests__/landlordActionToken.test.ts`. They cover: each mark branch then undo gives the exact prior rows (full row compare, decimals as MySQL returns them) and the same month settlement; refused when bank matched, allocated, amount changed, refunded, created row with reminders; second undo `already`; 404 without a mark or for another lease's mark; only the latest mark (`not_latest`), month undo goes newest first; email link marks the exact row as the landlord and the undo restores `failed`/`gocardless`; one internal note per mark and per undo; a failing note never fails the mark; reminder chain owed 780, after the mark 0 (the nothing_owed condition), after the undo 780 again with the sent reminder still recorded, then markable again. Routes: manager and owner undo, viewer and accountant 403, read token 403 (through `requireWriteScope`), other landlord 404, unknown lease 404, 409 passed through with code, source overview/api/mcp, manual-marks list 404 without access; email link page with undo link whose token expires with the paid link, confirm step, undo as the landlord, bank-matched message, mark of another payment not found, expired undo link.
- `apps/mcp-server npx vitest run`: 22 passed.
- `npx tsc --noEmit -p .`: clean in apps/api, apps/web and apps/mcp-server.
- `apps/web pnpm build` with placeholder DB_PASSWORD/AUTH_SECRET: exit 0.
- No em or en dashes in the added lines (grep count 0); no Co-Authored-By lines.
- Not verified: the Drizzle store against a real MariaDB (transaction, JSON column read back as a string is handled by parsing, `affectedRows` of the conditional update), the UI in a browser, the DDL on MariaDB.

## Deviations from Plan

**1. [Rule 2] `after_state` column added to the mark**
- Found during: design of the "changed since" check.
- Planned: compare `updated_at` against `marked_at` plus a tolerance, and the fields against what the mark set.
- Actual: the mark stores the row's fields right after the mark (`after_state`); undo is refused when the current fields differ from it (amounts by value, dates by day). An `updated_at` change alone (for example a reminder stamp) does not block, since nothing the mark set changed.
- Cost if wrong: one extra nullable JSON column; an edit that only touches other columns (fees, reminder stamps) does not block the undo, and those columns are kept as they are.

**2. `updated_at` is not restored**
- The undo sets every field the mark changed back exactly, but `updated_at` becomes the time of the undo. The tests compare full rows of the fields a mark can touch plus id, lease and due date.
- Cost if wrong: anything relying on `updated_at` sees the undo as a change, which it is.

**3. `/payments/:id/mark-paid` routed through the service too**
- The payments list's "Betaald (cash)" / "Betaald (overschrijving)" is a manual mark as well, so it is recorded (source `other`) and the payments list offers its undo.
- Cost if wrong: none expected; the answer only gains `markId`.

**4. Email link undo needs a confirm click**
- Planned: the page offers the undo. Actual: the undo link opens a confirm page first, so mail security scanners that open links cannot undo a mark.
- Cost if wrong: one extra click for the landlord.

## Assumption Drift (advisory)

- Found during: route rewrite. Planned: "same role check as mark (manager+)". Actual: same, plus 404 instead of 403 when the user has no role at all on the property, per the plan's tests ("other landlord 404"). Mark keeps its existing 403 for that case. Cost if wrong: none; it only hides the lease's existence.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-endpoint | apps/api/src/routes/payments.ts | POST /payments/unmark-month-paid (manager+, write scope, lease scoped) and GET /payments/manual-marks (any role on the property) |
| threat_flag: new-public-link | apps/api/src/routes/landlordActions.ts | public `unpaid` magic-link action: signed token bound to payment and mark, expires with the paid link, confirm step, mark must belong to that payment |

## Self-Check: PASSED

- FOUND: packages/db/src/schema/paymentManualMarks.ts, apps/api/src/services/manualMarks.ts, manualMarksStore.ts, both test files, apps/web/components/payments/ManualMarkUndo.tsx, prod-ddl.sql
- FOUND: commits f5470b4, d0e9383, f5e0bdd, c227021, e9bf1c2, 0931693, 07834ac
