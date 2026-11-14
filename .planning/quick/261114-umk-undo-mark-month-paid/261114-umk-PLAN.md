---
quick_id: 261114-umk
type: quick
autonomous: true
---

# Quick Task 261114-umk: Undo for "mark month paid" (API, overview, magic link, MCP), so manual marks are reversible

## Why

`POST /payments/mark-month-paid` (apps/api/src/routes/payments.ts ~line 900) has three branches: (a) partial month: an open row is turned paid with amount/rentAmount set to the shortfall, chargesAmount 0, notes appended; or a NEW paid row for the shortfall is inserted; (b) no open row: a NEW pending row is inserted and then transitioned to paid; (c) an open row is transitioned to paid and its method set. There is no way back. The only workaround, `POST /payments/:id/ignore`, leaves ignored rows behind. The owner has needed undo in real life (a hand-marked 780 for a tenant who had not paid cash had to be reverted in SQL), and the operations manager's daily API chain (send reminder, then mark paid, verify) cannot repeat because the next day's send-reminder correctly refuses with nothing_owed. Every manual "paid" must be reversible, exactly.

## Design

- New table `payment_manual_marks`: id, lease_id, month (YYYY-MM), payment_id, created_row boolean (the mark inserted this row), before_state json (status, amount, rent_amount, charges_amount, method, paid_date, notes, is_ignored of the row before the mark; null when created_row), source enum('overview','api','magic_link','mcp','other'), marked_by (user id or null for magic link with the landlord's id resolved from the token), marked_at, undone_at NULL, undone_by NULL. Index (lease_id, month, undone_at).
- Refactor the mark logic into a service `markMonthPaid({ db, lease, month, method, date, actor, source })` used by the route, by the landlord magic-link "paid" action (routes/landlordActions.ts) and by any other place that marks a month paid by hand (grep for transitionPayment(..., "paid") outside bank matching: overview, ledger record-payment if it marks months paid; list them in the SUMMARY and route the manual ones through the service). It records one mark row per call with the exact before state, and returns `markId`.
- `undoMonthPaid({ db, lease, month | markId, actor })` and `POST /payments/unmark-month-paid { leaseId, month }` (undoes the latest not-yet-undone mark for that lease+month; also accept `markId`): same role check as mark (manager+), write scope for tokens.
  - created_row: delete the row (and any payment_reminders rows pointing to it? no: a created row cannot have reminders before it existed; check allocations) only if it is still paid and not linked to a bank statement or allocation.
  - existing row: restore every field from before_state exactly and set status back to what it was (pending/processing) without breaking the payment state machine (if transitionPayment forbids paid -> pending, do a direct audited update and document it).
  - Refuse with 409 and a clear reason when the row has since been matched to a bank statement (bank_statements.matched_payment_id), has payment_allocations, or was changed after the mark in a way that makes a blind restore unsafe (updated_at newer than marked_at plus a small tolerance, and the fields differ from what the mark set). In that case tell the user what to do instead.
  - Idempotent: undoing an already undone mark returns 200 with `already: true`.
  - After undo, the month's settlement, remainder sweep, reminder ladder and dashboard behave as if the mark never happened (reminders already sent stay counted, they really went out).
- Communication history: both the mark and the undo add an internal note to the contract history (reuse the 261109-agr internal note mechanism, `audience: internal`, label "Interne notitie"): "November 2026 handmatig als betaald gemarkeerd (contant) door Jasper Nuyens" and "Markering als betaald ongedaan gemaakt door ...". EN/NL/FR/DE. Not counted in the 7-day message counter.
- Web: wherever a month shows as paid because of a manual mark (overview paid list, contract page, payments page), show "Ongedaan maken" (EN Undo, FR Annuler, DE Rückgängig) with a confirm; disabled with the reason when the API would refuse. After marking paid in the overview, the success toast has an "Ongedaan maken" action for a few seconds as well.
- Landlord magic-link email "paid" action: the confirmation page offers "Toch niet betaald? Ongedaan maken" within the token's validity, calling the same undo.
- MCP server (apps/mcp-server): add `unmark_rent_paid` (leaseId, month) next to `mark_rent_paid`; README table updated.
- docs/TESTING-OPERATIONS.md Part 3: the weekly/daily chain becomes send reminder, mark paid, check dashboard, then `POST /payments/unmark-month-paid` so the next run starts from the same state; explain that the history keeps the internal notes and the reminders that really went out.

## Schema

- Prod DDL (additive) to `.planning/quick/261114-umk-undo-mark-month-paid/prod-ddl.sql`. Never run db:generate. DDL first in the deploy order if code reads the table.

## Tests

- Each mark branch (partial reuse, partial insert, create+pay, reuse open row) followed by undo restores the exact prior DB state (compare full rows) and the dashboard/month settlement equals the pre-mark result.
- Undo refused when the row got bank-matched or allocated after the mark; idempotent second undo; undo of the latest mark only; permissions (viewer 403, read token 403, other landlord 404).
- Magic link paid then undo; internal notes written for both; reminder chain: friendly sent, mark paid, send-reminder refuses nothing_owed, undo, send-reminder accepted again.

## Checks

- api vitest green; apps/api, apps/web and apps/mcp-server `npx tsc --noEmit -p .`; apps/web `pnpm build` (placeholder DB_PASSWORD/AUTH_SECRET if needed).
- No em-dashes or en-dashes; no Co-Authored-By lines; all UI strings EN/NL/FR/DE with proper accents. Never deploy, never touch prod, never send messages, never run db:generate.
