---
quick_id: 261114-wal
type: quick
autonomous: true
---

# Quick Task 261114-wal: Wallonia PEB "loyer adapté" carry-forward, and stop enforcing the announced Flemish 2028/2030 indexation ban

## Findings (verified by the orchestrator on 2026-11-14)

1. Wallonia. apps/api/src/services/indexationCalc.ts (~line 269) returns the unrestricted rent: `// Wallonia: no EPC restrictions.` The official page https://logement.wallonie.be/fr/bail/indexation-loyer says: indexations due between 1 November 2022 and 31 October 2023 were limited by PEB label (decree of 19 October 2022): D 75% of the increase, E 50%, F, G or no PEB certificate 0% (A, B, C full). For dwellings with PEB D, E, F, G or without PEB, from then on "le loyer de base est : le loyer adapté entre le 1er novembre 2022 et le 31 octobre 2023 ; l'indice de départ est : l'indice santé du mois qui précède celui de la date anniversaire du bail intervenant entre le 1er novembre 2022 et le 31 octobre 2023. Ce mode de calcul s'applique jusqu'à la fin de la location." So the reduced rent carries forward for the rest of the lease; the lost indexation is never recovered. Note the limitation applied to the increase (75% / 50% of the increase), unlike Brussels.
   Official worked examples (rent 600, lease signed September 2021, in force November 2021, index August 2021 112.74, October 2022 127.92, October 2023 128.30):
   - PEB D: unrestricted Nov 2022 = 600 x 127.92 / 112.74 = 680.79; adapted = 600 + 75% x 80.79 = 660.59; Nov 2023 = 660.59 x 128.30 / 127.92 = 662.55.
   - PEB E: adapted 600 + 50% x 80.79 = 640.39; Nov 2023 = 642.29.
   - PEB F/G or no PEB: adapted 600; Nov 2023 = 600 x 128.30 / 127.92 = 601.78.
   The page also has examples where the previous possible indexation was in 2021 ("Dernière indexation possible = loyer indexé en 2021 = 600 x 137,61 / 119,47 = 691,10" and "600 x 113,94 / 107,55 = 635,65"): read the full page yourself (curl it; the content is in an embedded JSON blob, unescape it) and turn EVERY official example into a test with the official numbers.
   Also check on the page or in the decree whether the "no PEB" case can still be cured by later obtaining a certificate (Constitutional Court 20 June 2024 is mentioned by secondary sources: a dwelling without PEB may be indexed, treated like F/G with the adapted-rent method). Implement only what the official page states; document anything uncertain in the SUMMARY.
   Leases that took effect after 31 October 2023, or whose anniversary indexation did not fall in the window, are unaffected.
   Prod has no Walloon leases (all 13 are Flanders), so no data migration.
2. Flanders future ban. `FLANDERS_FUTURE_RESTRICTIONS` (packages/shared/src/constants/index.ts ~410: 2028 E and F, 2030 D, E and F) is enforced in indexationCalc.ts (~535) as law. It is an announced plan from the Flemish coalition agreement 2024-2029, not a voted decree; sources disagree on its content (E and F, or minimum label D), and the 2030 measure in the sources is a RENTAL ban for E/F, not an indexation ban for D/E/F. Stop enforcing it: keep the data only as an "announced, not law" notice. In the indexation calculation result and UI, when a Flemish lease would be affected by the announced plan, show a neutral warning (EN/NL/FR/DE) such as NL "Aangekondigd door de Vlaamse regering: vanaf 2028 mogelijk geen indexatie meer voor EPC-label E of F. Dit is nog geen wet; Rentular past het pas toe als het decreet gestemd is." Put it behind a flag constant `FLANDERS_FUTURE_BAN_IN_FORCE = false` so it can be switched on once a decree is published, with a comment to verify the exact labels and dates then.

## Task 1: Wallonia

- Model: for a Walloon lease, determine whether an anniversary indexation fell between 2022-11-01 and 2023-10-31 (anniversary = lease effective date month/day; use the same "month preceding the anniversary" index rule as the rest of the code), and the PEB label (and no-certificate) at that time. Persist the outcome per lease, because the label may change later and the law fixes the base from then on: add to leases `wallonia_adapted_rent decimal(10,2) NULL`, `wallonia_adapted_index decimal(8,2) NULL`, `wallonia_adapted_index_month varchar(7) NULL` (YYYY-MM), `wallonia_peb_label_2022 varchar(4) NULL`. When these are set, every later indexation uses base rent = adapted rent and base index = adapted index. When not set (lease not yet processed), compute them on the fly from the lease's base rent/base index and the label in effect (the lease's EPC label, plus an optional explicit "PEB label in Nov 2022 to Oct 2023" field on the contract form for leases whose label changed since; EN/NL/FR/DE), and persist them on the first apply.
- Labels A++, A+, A, B, C: unaffected. D: 75% of the increase. E: 50%. F, G, none: 0%.
- Indexation preview and letter: explain in one line which base is used and why ("Waalse regel: basishuur 660,59 euro (aangepaste huur PEB D, november 2022), basisindex 127,92").
- Tests: every official example from the page with its exact numbers; a lease that started after 2023-10-31 (unaffected); a lease whose anniversary is in the window with label C (unaffected); label change after 2023 does not change the base; Brussels and Flanders results unchanged.

## Task 2: Flanders announced ban

- `FLANDERS_FUTURE_BAN_IN_FORCE = false`; the restriction loop only runs when it is true; when false, add `announcedRestriction` info to the result for the UI warning. Update tests: a 2028 E lease is indexed normally and carries the warning. Fix the comment that presented it as law. Do not touch the existing Flemish freeze and correction factor logic.

## Schema

- Prod DDL (additive) to `.planning/quick/261114-wal-wallonia-peb-and-flemish-plan/prod-ddl.sql`. Never run db:generate. DDL first in the deploy order if code reads the columns.

## Checks

- api vitest green; apps/api and apps/web `npx tsc --noEmit -p .`; apps/web `pnpm build` (placeholder DB_PASSWORD/AUTH_SECRET if needed).
- No em-dashes or en-dashes; no Co-Authored-By lines; all UI strings EN/NL/FR/DE with proper accents. Never deploy, never touch prod. Do not edit apps/api/src/lib/gocardless.ts or GoCardless routes (another task owns them).
