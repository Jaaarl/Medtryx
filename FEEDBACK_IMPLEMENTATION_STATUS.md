# Medtryx feedback implementation status

This file tracks the numbered feedback from the user's follow-up request. Existing operational databases and files are not part of these changes. Local tests must use the isolated synthetic test database. Software verification does not satisfy professional policy approval, physical-site checks, or live release gates.

## Original numbered feedback

1. when creating a product there should be a separate checkbox if it is eligible for senior citizen only or pwd only or both...
2. when creating a product there should be a radio button telling if it is generic or branded.
3. Also there is only 1 cash register. currently we can open mutiple cash registar based on the account
4. Also as a owner i want to see the history of the opening and clossing of shift, what account name opened that time, and the how much money invloved in the registar during that time.
5. it should have a monthly report right now it is only in daily report. maybe add like a date ranger

```text
6. Can you also implement add this option to the rounding of fraction.. curently it is accepting&#x20;
roudup, roundown, turnate...  the explanation for this table it is more which is more near for the .25 centavos

| Exact total ending Rounded cash total  |            |
| -------------------------------------- | ---------- |
| `.00 – .12`                            | `.00`      |
| `.13 – .37`                            | `.25`      |
| `.38 – .62`                            | `.50`      |
| `.63 – .87`                            | `.75`      |
| `.88 – .99`                            | next `.00` |
```

No screenshots or reproduction steps were attached to the request.

## Items and bundles

| ID  | Feedback | Affected area                                                     | Acceptance check                                                                                                                                                                                                                                                                     | Dependencies                   | Status   | Evidence / decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 1        | Product eligibility, checkout validation, and sale snapshots      | Owner can independently set Senior Citizen and PWD eligibility; each benefit is accepted only for products eligible for that benefit; edits persist; existing products migrate without losing their prior combined eligibility; immutable sale lines retain both eligibility values. | None                           | verified | Migrations `0006_product_classifications.sql` and `0007_sale_product_classification_snapshots.sql`; legacy combined eligibility maps to both flags. API/unit suite: 46 passed; typecheck, lint, format check, build, and Chromium e2e: 3 passed. Feature commit: `062de48`.                                                                                                                                                                                                                                                                                                                                          |
| F2  | 2        | Product classification                                            | Owner can choose Generic or Branded using a required radio selection for new products; it persists across edits and is returned in product/catalog views and immutable sale lines. Existing products with no known value remain visibly unclassified until reviewed.                 | None                           | verified | `product_type` is owner-maintained and does not infer tax class or benefit eligibility. API/unit suite: 46 passed; typecheck, lint, format check, build, and Chromium e2e: 3 passed. Feature commit: `062de48`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| F3  | 3        | Shift opening / cash-register concurrency                         | At most one shift can be open store-wide, even when separate cashier accounts race to open; a second account receives a clear conflict and can open after the active shift closes.                                                                                                   | None                           | verified | Migration `0008_single_store_register.sql` adds a database-enforced global unique index; API rejects competing opens with HTTP 409; checkout disables opening for a second account. Concurrent-open API, migration rollback, and browser checks pass using synthetic isolated data. Feature commit: `2583517`.                                                                                                                                                                                                                                                                                                       |
| F4  | 4        | Owner shift history                                               | Owner can review every opening/closing, opening and closing account names, timestamps, opening float, expected cash, actual count, and variance. Cashiers remain limited to their current shift.                                                                                     | F3                             | verified | Owner-only `/api/shifts/history` and **Shift history** page show opener/closer accounts and times, opening float, cash/QR sales, refunds, cash-in/out, expected cash, actual count, and variance. API verifies totals and denies cashier access; browser workflow passes. Feature commit: `2583517`.                                                                                                                                                                                                                                                                                                                 |
| F5  | 5        | Reports and CSV export                                            | Owner can select any valid inclusive Manila date range, see aggregates for that interval, and export the same interval; daily selection remains available and totals reconcile across boundary dates.                                                                                | Existing daily reporting logic | verified | Owner can select inclusive Manila start/end dates, view the aggregated interval, use Month to date, and export the same period. Daily APIs remain compatible; current stock is labeled as current. API tests cover sales/reversal attribution across a month boundary, daily-range parity, CSV parity, invalid ranges, and cashier denials. Feature commit: `18bb74b`.                                                                                                                                                                                                                                               |
| F6  | 6        | Cash-total rounding, sale/refund snapshots, checkout, and reports | Owner can select None or nearest ₱0.25 in the approved policy; the supplied centavo intervals round cash cart totals correctly, leave QR totals and line tax calculations unchanged, preserve the adjustment through full refund, and expose it separately in sales/report records.  | Existing approved tax policy   | verified | Migration `0009_cash_total_rounding.sql`; owner-only approved policy selection defaults to None and remains compatible with prior saved policies. Integer-centavo boundary tests cover all table breakpoints; API tests verify CASH/QR behavior, sale snapshots, drawer totals, both positive and negative refunds, report/CSV separation and reversal offsets; browser workflow verifies policy selection and the saved cash amount. Full suite: 67 tests; typecheck, lint, format check, build, and 4 Chromium flows pass. Cash-rounding professional approval remains a live-use gate. Feature commit: `995b4e9`. |

## Bundles

1. **Product classifications and benefit eligibility (F1, F2)** — Schema migration, owner API validation/persistence, catalog and checkout presentation/validation, regression tests, and specification updates. Dependencies: none.
2. **Single store register and shift history (F3, F4)** — Store-wide open-shift invariant, concurrent API coverage, owner-only shift history API and UI, regression tests, and specification updates. F4 depends on F3's store-wide register behavior.
3. **Date-range reports (F5)** — Manila-inclusive interval aggregation, validated report and CSV endpoints, date-range UI, regression tests, and specification updates. Dependencies: existing reporting bundle.

4. **Cash-total rounding (F6)** — Approved policy option, exact-centavo rounding helper, cash-only checkout preview/finalization, immutable sale/refund adjustment snapshots, report and receipt disclosure, regression/browser tests, and documentation. Dependencies: existing approved tax policy and sale/reversal/report flows.

## Verification and commits

### Bundle 1 — Product classifications and benefit eligibility (F1, F2)

- Status: verified.
- Changes: separate SC/PWD flags with benefit-specific server validation; Generic/Branded radio classification; legacy data migrations; product and sale-line snapshots; owner/catalog/checkout UI; README and product/technical specification updates.
- Verification: `npm.cmd test` — 46 tests passed; `npm.cmd run typecheck` passed; `npm.cmd run lint` passed; `npm.cmd run format:check` passed; `npm.cmd run build` passed; `npm.cmd run test:e2e` — 3 Chromium workflows passed. E2E uses a temporary database and dynamically allocated local ports.
- Commit: `062de48` (`feat(catalog): split benefit eligibility and product type`).

Keep physical/device/network checks and professional approval gates visible as pending in `IMPLEMENTATION_STATUS.md`.

### Bundle 2 - Single store register and shift history (F3, F4)

- Status: verified in local synthetic development/test workflows.
- Changes: migration `0008_single_store_register.sql`; one globally open shift enforced by SQLite and the API; clear blocked state for a second cashier; owner-only shift-history API and page with opening/closing accounts, timestamps, and cash reconciliation; product and deployment-document updates.
- Upgrade behavior: if an existing database has more than one open shift, migration 0008 fails atomically and preserves all shifts and the prior index. The owner must reconcile actual drawers and close shifts with counted cash before retrying against a verified backup. No automatic counts or closures are invented.
- Verification: focused `sales.test.ts` and `db.test.ts` - 14 tests passed; full unit/API suite - 50 passed; `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run format:check`, and `npm.cmd run build` passed; `npm.cmd run test:e2e` - 4 Chromium workflows passed (including second-account register denial, owner history values and authorization, and loading older history). E2E used the runner's isolated synthetic database and dynamically allocated local ports. `git diff --check` passed.
- Feature commit: `2583517` (`feat(register): enforce one cash register and add shift history`).
- Focused pagination-test fixture follow-up: `47131c4` (`test(register): keep history pagination fixture fast`).

### Bundle 3 - Date-range reports (F5)

- Status: verified in local synthetic development/test workflows.
- Changes: added owner-only inclusive Manila date-range JSON and CSV routes while preserving the daily endpoints; updated the Reports page with start/end controls and a Month to date shortcut; labeled inventory figures as current; updated the simplified specification, roadmap, and README.
- Verification: full unit/API suite - 51 tests passed, including date-boundary attribution for sales versus reversals, same-day compatibility, totals/CSV parity, invalid date-range rejection, and cashier denial. `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run format:check`, and `npm.cmd run build` passed. `npm.cmd run test:e2e` - 4 Chromium workflows passed, including date-range selection, CSV download, month-to-date, and cashier API denial. E2E used the isolated synthetic database and dynamic local ports. `git diff --check` passed.
- Feature commit: `18bb74b` (`feat(reports): add inclusive date-range reporting`).

### Bundle 4 — Cash-total rounding (F6)

- Status: verified in local synthetic development/test workflows.
- Changes: owner-approved optional nearest-₱0.25 cash-total mode; exact signed centavo adjustment computed only on the combined CASH total; unchanged QR and per-line tax amounts; immutable sale/refund adjustment snapshots; rounded shift cash and checkout totals; separate report/CSV adjustment metric; owner policy, cashier checkout, receipt/history UI, specifications, roadmap, and release-gate updates.
- Migration: `0009_cash_total_rounding.sql` adds default `NONE` and zero adjustments to legacy sales and reversals without rewriting their saved totals. Prior approved tax settings without this new field continue to load with `NONE`.
- Verification: `npm.cmd test` — 67 tests passed; `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run format:check`, and `npm.cmd run build` passed; `npm.cmd run test:e2e` — 4 Chromium workflows passed, including owner policy selection, cash preview/finalization, drawer reconciliation, and reversal. `git diff --check` passed. Tests used temporary synthetic databases and local test ports.
- Runtime note: checks ran on Node.js 26.10.0, outside the project's Node.js 24-only engine range. Node 24 was not available on PATH; repeat the full check set on Node 24 before release.
- Feature commit: `995b4e9` (`feat(checkout): add nearest quarter cash rounding`).
- Release gate: accountant/professional approval is still required before selecting nearest-₱0.25 for live sales; no physical-site check or live deployment was performed.
