# Medtryx feedback implementation status

This file tracks the numbered feedback from the user's follow-up request. Existing operational databases and files are not part of these changes. Local tests must use the isolated synthetic test database. Software verification does not satisfy professional policy approval, physical-site checks, or live release gates.

## Original numbered feedback

1. when creating a product there should be a separate checkbox if it is eligible for senior citizen only or pwd only or both...
2. when creating a product there should be a radio button telling if it is generic or branded.
3. Also there is only 1 cash register. currently we can open mutiple cash registar based on the account
4. Also as a owner i want to see the history of the opening and clossing of shift, what account name opened that time, and the how much money invloved in the registar during that time.
5. it should have a monthly report right now it is only in daily report. maybe add like a date ranger

No screenshots or reproduction steps were attached to the request.

## Items and bundles

| ID  | Feedback | Affected area                                                | Acceptance check                                                                                                                                                                                                                                                                     | Dependencies | Status   | Evidence / decision                                                                                                                                                                                                                                                                                                      |
| --- | -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 1        | Product eligibility, checkout validation, and sale snapshots | Owner can independently set Senior Citizen and PWD eligibility; each benefit is accepted only for products eligible for that benefit; edits persist; existing products migrate without losing their prior combined eligibility; immutable sale lines retain both eligibility values. | None         | verified | Migrations `0006_product_classifications.sql` and `0007_sale_product_classification_snapshots.sql`; legacy combined eligibility maps to both flags. API/unit suite: 46 passed; typecheck, lint, format check, build, and Chromium e2e: 3 passed. Feature commit: `062de48`.                                              |
| F2  | 2        | Product classification                                       | Owner can choose Generic or Branded using a required radio selection for new products; it persists across edits and is returned in product/catalog views and immutable sale lines. Existing products with no known value remain visibly unclassified until reviewed.                 | None         | verified | `product_type` is owner-maintained and does not infer tax class or benefit eligibility. API/unit suite: 46 passed; typecheck, lint, format check, build, and Chromium e2e: 3 passed. Feature commit: `062de48`.                                                                                                          |
| F3  | 3        | Shift opening / cash-register concurrency                    | At most one shift can be open store-wide, even when separate cashier accounts race to open; a second account receives a clear conflict and can open after the active shift closes.                                                                                                   | None         | verified | Migration `0008_single_store_register.sql` adds a database-enforced global unique index; API rejects competing opens with HTTP 409; checkout disables opening for a second account. Concurrent-open API, migration rollback, and browser checks pass using synthetic isolated data. Feature commit to be recorded below. |
| F4  | 4        | Owner shift history                                          | Owner can review every opening/closing, opening and closing account names, timestamps, opening float, expected cash, actual count, and variance. Cashiers remain limited to their current shift.                                                                                     | F3           | verified | Owner-only `/api/shifts/history` and **Shift history** page show opener/closer accounts and times, opening float, cash/QR sales, refunds, cash-in/out, expected cash, actual count, and variance. API verifies totals and denies cashier access; browser workflow passes. Feature commit to be recorded below.           |
| F5  | 5        | Reports and CSV export                                       | Owner can select any valid inclusive Manila date range, see aggregates for that interval, and export the same interval; daily selection remains available and totals reconcile across boundary dates.                                                                                | None         | pending  | Current report accepts one date only. Bundle 3 extends aggregation and UI/CSV to date ranges. The request does not require new report metrics or accounting policy.                                                                                                                                                      |

## Bundles

1. **Product classifications and benefit eligibility (F1, F2)** — Schema migration, owner API validation/persistence, catalog and checkout presentation/validation, regression tests, and specification updates. Dependencies: none.
2. **Single store register and shift history (F3, F4)** — Store-wide open-shift invariant, concurrent API coverage, owner-only shift history API and UI, regression tests, and specification updates. F4 depends on F3's store-wide register behavior.
3. **Date-range reports (F5)** — Manila-inclusive interval aggregation, validated report and CSV endpoints, date-range UI, regression tests, and specification updates. Dependencies: existing reporting bundle.

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
- Feature commit: pending at time of this status update; record hash after commit.
