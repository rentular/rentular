---
quick_id: 261114-wal
status: complete
completed: 2026-11-14
subsystem: indexation
tags: [wallonia, peb, epc, flanders, indexation, health-index]
key-files:
  created:
    - apps/api/src/services/__tests__/walloniaPeb.test.ts
    - apps/web/components/WalloniaPebNote.tsx
    - apps/web/components/FlandersAnnouncedNote.tsx
    - .planning/quick/261114-wal-wallonia-peb-and-flemish-plan/prod-ddl.sql
  modified:
    - packages/shared/src/constants/index.ts
    - packages/db/src/schema/leases.ts
    - apps/api/src/services/indexationCalc.ts
    - apps/api/src/services/indexationEmail.ts
    - apps/api/src/services/indexationAlerts.ts
    - apps/api/src/routes/indexation.ts
    - apps/api/src/routes/leases.ts
    - apps/api/src/routes/__tests__/indexation.test.ts
    - apps/api/src/services/__tests__/indexationCalc.test.ts
    - apps/api/src/services/__tests__/indexationEmail.test.ts
    - apps/web/app/(dashboard)/indexation/page.tsx
    - apps/web/app/(dashboard)/leases/page.tsx
    - apps/web/messages/{en,nl,fr,de}/common.json
---

# Quick 261114-wal: Walloon PEB carry-forward and the announced Flemish ban

Wallonia now follows the decree of 19 October 2022 as the official page describes it: an indexation whose anniversary falls from 1 November 2022 to 31 October 2023 gets D 75%, E 50%, F/G/no certificate 0% of the increase over the rent due before that anniversary. For D to G or no certificate, that "loyer adapté PEB" and the index of the month before the anniversary are the base for the rest of the lease. The base is stored on the lease at the first apply. The announced Flemish 2028 ban is no longer enforced; it shows up as a neutral notice behind `FLANDERS_FUTURE_BAN_IN_FORCE = false`.

## Commits

| Commit | What |
|---|---|
| f628922 | Walloon constants, calculation (`walloniaWindowAnniversary`, `walloniaAdaptedRent`, `resolveWalloniaPeb`, `applyWalloniaPebRestriction`), tests with every official example |
| 82a251f | Lease columns, storing on first apply, contract field for the 2022-2023 label, letter paragraph (NL/EN/FR/DE), route tests |
| 10a53d9 | Flemish announced ban: flag off, `announcedRestriction` in the result, 2030 entry dropped, tests |
| 4e1eac2 | Web: Walloon note in indexation dialog and contract form, contract field, Flemish notice, EN/NL/FR/DE strings, prod DDL |

## Official examples checked (https://logement.wallonie.be/fr/bail/indexation-loyer, fetched with curl on 2026-11-14, JSON blob unescaped)

All index values the page uses were cross-checked against the Statbel open data file "CPI All base years" (health index): 2012-08 98.92 (base 2004: 119.47), 2018-08 107.55, 2019-08 109.07, 2019-10 108.98 (base 2004: 131.62), 2021-08 112.74, 2021-10 113.94 (base 2004: 137.61), 2022-10 127.92 (base 2004: 154.49), 2023-10 128.30. All match.

Each example is a test in `walloniaPeb.test.ts`, with the official numbers hard-coded:

| Example | Official numbers | Test result |
|---|---|---|
| 2019 lease, PEB D, 1/11/2022 | 703,69 indexed, 626,79 due, 75% of 76,90 = 57,68, new 684,47 | pass (pure function and computeIndexationCore) |
| 2019 lease, PEB E, 1/11/2022 | 50% of 76,90 = 38,45, new 665,24 | pass (see page typo below) |
| 2021 lease, PEB D | 680,79 standard, adapted 660,59, Nov 2023 662,55 | pass |
| 2021 lease, PEB E | adapted 640,39, Nov 2023 642,29 | pass |
| 2021 lease, PEB F or G | adapted 600, Nov 2023 601,78 | pass (F and G) |
| 2021 lease, no PEB | adapted 600, Nov 2023 601,78 | pass |
| 2012 lease, F/G/none, not indexed since 2019 | 661,02 kept in Nov 2022, 775,88 standard, adapted 691,10, Nov 2023 693,15 | pass |
| 2018 lease, F/G/none, never indexed | 713,64 standard, 600 kept, adapted 635,65, Nov 2023 637,54 | pass |
| Lease in force 1/11/2022 | indexed from 1/11/2023 without PEB rule | pass (G label, full indexation) |

Rounding: the official numbers only come out when the intermediate amounts stay unrounded and only the result is rounded (e.g. 50% of 80,7876 = 40,39, 75% of 76,9047 = 57,68). The code does exactly that. The Nov 2023 step uses the stored, rounded adapted rent (660,59 x 128,30 / 127,92 = 662,55), as the page does.

Page quirks:
- E example of the 2019 lease writes "626,90 euros + 38,45 euros = 665,24 euros". 626,79 is the right figure and the sum 665,24 is consistent with it; the test uses 626,79.
- The 2012 example uses base 2004 indices for 2012 to 2022 and base 2013 indices for the 2023 step. Fully in base 2004 the Nov 2023 figure would be 693,16, not 693,15. The app stores base 2013, so the integration test runs in base 2013 (base index 98.92) and gets 691,10 and 693,15. The 775,88 figure is base 2004 (base 2013 gives 775,90); it is tested on the pure function with the page's base 2004 values.
- The "landlord forgot to index" example (PEB D, in force 1 May 2019, asked in December 2023) has no amounts, so there is no number to test. Its rule (the limitation still applies to a late request) holds: the window anniversary keeps phase "window" whatever the date of the request.

## Behaviour decisions

- **Scope:** lease in force before 1 November 2022 (string compare on YYYY-MM-DD), not commercial (commercial leases follow federal law; my assumption, the page only talks about housing). Student leases are already never indexed in the app. Every such lease has exactly one anniversary in the window (November and December anniversaries in 2022, the others in 2023).
- **Rent due before the window:** the contract rent indexed at the previous anniversary ("même si l'indexation n'a pas été demandée"), or the contract rent when the window anniversary is the first one.
- **At the window anniversary itself:** D/E get the adapted rent; F/G/none keep the current rent, capped at the adapted rent (the page: "le loyer est maintenu à 661,02"). This only matters for calculations dated in the window; today every lease is past it.
- **After it:** `min(standard indexed rent, round2(adapted rent x current index / adapted index))`. No floor at the contract rent, so the law's formula is never raised.
- **Label:** `wallonia_peb_label_2022` when set, else the property's current EPC label, else "none". Unknown labels count as no certificate (0%). A++/A+ count as A.
- **Storing:** apply stores the label, and for D to G or none the adapted rent, index and month, the first time (only when the window anniversary is reached and no index is missing). Stored values are then used as they are, so a later certificate does not change the base (tested). Label A++ to C stores only the label.
- **Correcting data:** saving the contract with a different 2022-2023 label, start date, contract rent or base index drops the stored adapted rent (the label is kept unless it is the field that changed), so the next calculation recomputes it from the corrected data. The contract-form preview mirrors this.
- **Missing health index:** if the index of the window month or the previous year's month is not in the database, indexation is blocked with `wallonia_index_missing` (apply and letter preview return 400) instead of guessing.
- **Letter:** after the window, the "base rent", "base index" and its month lines show the adapted rent and its index, and a paragraph cites the Walloon decree of 19 October 2022 with the label, the share and the formula line, in NL/EN/FR/DE.
- **Flanders:** `FLANDERS_FUTURE_BAN_IN_FORCE = false`; the restriction loop only runs when it is true (test with it forced on gives the base rent, off gives the normal correction). `announcedRestriction` = `{ fromYear: 2028, labels: ["E", "F"], inForce: false }` for Flemish residential (not student, not commercial) leases with EPC E or F. The UI shows the neutral notice (NL text as in the plan). A 2028 E lease after October 2022 indexes in full; an older 2028 E lease keeps the existing correction factor. Freeze and correction factor logic untouched.

## Uncertain, not implemented (needs a legal check)

1. **Constitutional Court, 20 June 2024:** the official page does not mention it. It treats "no PEB certificate" exactly like F/G: no increase in the window, then indexation from the adapted rent until the end of the lease. That is what is implemented. The page gives no way to cure the base with a later certificate ("Ce mode de calcul s'applique jusqu'à la fin de la location"), so a later certificate changes nothing. I did not read the judgment itself.
2. **Registration in Wallonia:** the page ends with "Pour indexer le loyer d'un bail de résidence principale, il faut que le bail soit enregistré". Walloon leases are not blocked when unregistered (the Brussels task added `lease_registered`, which only blocks Brussels). Recommend a follow-up to block unregistered Walloon main residence leases too.
3. **Arrears window:** the page allows arrears for the three months before the month of the request (December request: September to November). The effective-date options use three months before today by day, so for a request on 10 December the earliest offered due date is 1 October. This under-claims, never over-claims; left as is.
4. **Legal reference in the Walloon letter** still says "Code civil, art. 1728bis". The Walloon decree of 15 March 2018 on housing leases (art. 26) would be more precise. Not changed.
5. **Flemish rules for commercial leases:** the existing Flemish freeze/correction code does not exclude commercial leases. Not touched (out of scope).

## Checks run (observed)

- `apps/api`: `npx vitest run`: 78 files, **767 tests passed**.
- `apps/api`: `npx tsc --noEmit -p .`: clean.
- `apps/web`: `npx tsc --noEmit -p .`: clean.
- `apps/web`: `pnpm build` with placeholder DB_PASSWORD/AUTH_SECRET: succeeded.
- i18n completeness test: 7 passed (all new keys in EN/NL/FR/DE).
- Diff and commit messages: no em-dashes or en-dashes, no Co-Authored-By lines. No GoCardless file touched.
- Not verified: rendering in a browser, and the DDL against MariaDB (both need prod or a live DB).

## Deviations

1. **[Rule 2] Missing health index blocks the Walloon indexation** (`wallonia_index_missing`) rather than falling back to the full rent. Cost if wrong: a landlord waits until the health index table has the 2021 to 2023 months (it should already).
2. **[Rule 2] Correcting the start date, contract rent, base index or 2022-2023 label drops the stored adapted rent.** The plan only said "persist on first apply". Cost if wrong: a correction recomputes the base from the corrected data instead of keeping the first value.
3. **FLANDERS_FUTURE_RESTRICTIONS keeps only 2028 {E, F}.** The plan said to keep the data; the 2030 {D, E, F} entry is dropped because the sources describe a rental ban for E/F in 2030, not an indexation ban, and showing a D-label warning would be unsupported. Cost if wrong: D leases get no notice; nothing about rents changes.
4. **Commercial leases excluded from the Walloon rule** (assumption, see above). Cost if wrong: a Walloon commercial lease with D to G before 2022-11 indexes in full.
5. The existing test "leaves Wallonia unchanged" was wrong under the new rule (EPC E lease of 2019); rewritten with real Statbel April indices to check the Walloon result (adapted 762,74, 2026 rent 838,77).
6. Ran `pnpm install --frozen-lockfile` in the worktree (no new packages) to get node_modules for the checks.

## Deploy order

1. If not yet done: run `.planning/quick/261114-bru-brussels-epc-indexation-fix/prod-ddl.sql` on prod MariaDB (`rentular`).
2. Run `.planning/quick/261114-wal-wallonia-peb-and-flemish-plan/prod-ddl.sql` (additive: `wallonia_peb_label_2022`, `wallonia_adapted_rent`, `wallonia_adapted_index`, `wallonia_adapted_index_month`). **Before step 3**: the code selects these columns (`select()` from leases).
3. Merge, build web, `pm2 restart` web and api as usual.
4. No data migration: prod has no Walloon leases (all 13 are Flanders). Flemish E/F leases will show the announced-ban notice; their rents do not change.

## Known stubs

None.

## Self-Check: PASSED

- Files exist: walloniaPeb.test.ts, WalloniaPebNote.tsx, FlandersAnnouncedNote.tsx, prod-ddl.sql.
- Commits exist: f628922, 82a251f, 10a53d9, 4e1eac2.
