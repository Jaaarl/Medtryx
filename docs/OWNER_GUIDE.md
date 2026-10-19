# Medtryx owner guide

This guide describes the owner-facing workflows currently implemented in Medtryx. The owner assistant uses this guide to answer questions. If a workflow is not described here, it should say that it cannot confirm the answer and direct the owner to the relevant page or a developer.

## What Medtryx does

Medtryx is a point-of-sale and pharmacy operations web app for one store, hosted on a local server. It uses a local SQLite database. The browser connects to the server on the local network. Product, stock, checkout, sales, cash shifts, expenses, reports, and backups are handled in the app. The app does not replace accountant review, physical cash counts, or site reconciliation.

## Accounts and access

Owners sign in with their username or email and password. The first owner is created with a command-line bootstrap; there is no public registration. Owners can create, deactivate, and reactivate owner and cashier accounts in Settings. Users can change their own password in My account. Cashiers have access to checkout and their daily operational pages. Owner-only pages include product and stock management, receipt receiving, bundles, sales history, reports, product movement, shift history, activity log, backups, and Settings.

## Products

Owners can create, search, edit, deactivate, and reactivate products. Product setup includes Generic or Branded classification and separate Senior Citizen and PWD benefit eligibility. Catalog entries from an initial draft are inactive until reviewed. Review product type, tax class, unit, and other POS fields before activating a product.

## Stock and receipt receiving

Owners can record opening stock, supplier receipts, count corrections, and write-offs, then review current stock value and stock history. Receipt receiving can send uploaded receipt pages to MixRoute for extraction and suggestions. The owner reviews the generated CSV, confirms product matches and product fields, and explicitly approves package-to-piece conversions before importing. AI suggestions alone do not change inventory. Uploads sent for extraction are not retained by this workflow.

## Checkout, sales, and shifts

Cashiers search active products, build a browser cart, and preview server-calculated prices, taxes, and discounts before finalizing an approved cash or QR-declared sale. The store uses one shared cash register shift; a second cashier cannot open another shift while it is open. QR declarations do not change physical drawer cash. Manual checkout can record a sale without a shift.

Owners can review immutable sale records and record a linked full reversal after reauthentication, choosing stock restoration per line. Cash refunds require an open drawer with enough expected cash. Shift history includes opening and closing details, sales, refunds, expected and counted cash, and variance decisions. It does not replace physical drawer counts or site reconciliation.

## Reports, journal, and expenses

Owners can review sales reports for an inclusive Manila date range, including month-to-date, and export the same range to CSV. Exports omit customer identifiers. The journal and daily sales pages summarize recorded sales and operational cash activity. Owners can review payments and expenses and their history. Product gross-profit figures are estimates: until accountant-approved settings are recorded, they use a clearly labeled provisional 12% VAT-inclusive assumption. Checkout remains blocked until the owner records accountant-approved tax and acquisition-cost settings. Do not treat estimates as accounting advice.

## Discounts and benefits

Benefit eligibility is configured per product. The app records the owner's BNPC policy settings and records the policy applied to a sale. Confirm applicable legal and accountant guidance before changing benefit policy. The assistant can explain where settings are managed, but cannot determine legal eligibility or approve a policy.

## Backups and recovery

Owners can configure the store identity, create two verified backup copies, and restore after owner reauthentication, store-name confirmation, and creation of a verified safety backup. Live backups require absolute local paths, and the second copy must be on a separately controlled physical storage device. Automatic live backups run daily after 02:00 Manila time once the owner has configured the store identity. See `docs/DEPLOYMENT_AND_RECOVERY.md` for the recovery procedure.

## Local deployment

Development and test use separate SQLite files under `data/` by default. Live deployment requires `APP_ENV=live` and an absolute `MEDTRYX_DATA_DIR` outside the repository. Apply SQL migrations with `npm run db:migrate` for the selected environment. The live server is intended to bind to loopback behind a local HTTPS proxy. See `docs/DEPLOYMENT_AND_RECOVERY.md` before pilot deployment or recovery.

## Owner assistant scope and privacy

The owner assistant answers questions about current Medtryx workflows using this guide. It does not inspect source code, read the database, view live store records, run commands, or change code or app data. It has no tools that can perform those actions. Chat messages are kept in the browser page state only and are not saved by the Medtryx app. To generate an answer, the app sends the question, recent chat turns, and selected sections of this guide to MixRoute using the configured `MIXROUTE_API_KEY`. Do not include customer identifiers, passwords, API keys, or other secrets in a question. If an answer is uncertain or the feature is missing from this guide, ask a developer to verify the source code or update this guide.
