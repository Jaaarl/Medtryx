# Medtryx owner guide

This guide explains the owner and cashier workflows currently available in Medtryx. It is also the knowledge source used by the read-only **Owner help** chatbot. Screen names can change between releases; if a screen does not match this guide, check the release notes or ask the Medtryx developer before relying on a different procedure.

## Contents

- [What Medtryx does](#what-medtryx-does)
- [Accounts, roles, and sign-in](#accounts-roles-and-sign-in)
- [Product catalog](#product-catalog)
- [Stock and receipt receiving](#stock-and-receipt-receiving)
- [Receiving a supplier receipt](#receiving-a-supplier-receipt)
- [Checkout and sales](#checkout-and-sales)
- [Cash register shifts and cash counts](#cash-register-shifts-and-cash-counts)
- [Virtual bundle offers](#virtual-bundle-offers)
- [Senior Citizen, PWD, and BNPC benefits](#senior-citizen-pwd-and-bnpc-benefits)
- [Sale history, refunds, and reversals](#sale-history-refunds-and-reversals)
- [Reports, daily sales, and CSV exports](#reports-daily-sales-and-csv-exports)
- [Journal, payments, and expenses](#journal-payments-and-expenses)
- [Settings and activity history](#settings-and-activity-history)
- [Backups and restore](#backups-and-restore)
- [Local installation and upgrades](#local-installation-and-upgrades)
- [Owner help chatbot: answers, limits, and privacy](#owner-help-chatbot-answers-limits-and-privacy)
- [Page-by-page manual](#page-by-page-manual)
- [Common problems](#common-problems)

## What Medtryx does

Medtryx is a point-of-sale and pharmacy operations application for one store on one local server. The server uses SQLite for application records. A browser on the local network connects to that server. The app tracks the product catalog, stock movements, sales, one shared cash-register shift, expenses, reports, user accounts, and backups.

Medtryx is an operational record system. It does not count the physical drawer, verify that a QR payment reached a bank account, verify stock on a shelf, reconcile purchases made through another store or online channel, or replace accountant review. Staff must compare the app with physical records and follow the store's approved procedures.

## Accounts, roles, and sign-in

There is no public sign-up page. The first owner account is created once from the server command line during installation. After signing in, an owner can create, deactivate, or reactivate owner and cashier accounts in **Settings**. Users can change their own password in **My account**. Owners should promptly deactivate an account when its access is no longer needed.

Owners can manage products, stock, supplier receipt imports, bundles, sales history, reversals, reports, product movement, shift history, the activity log, backups, and application settings. Cashiers can use the checkout and daily operational pages allowed by their role. A cashier cannot open owner-only management pages. Do not share accounts: the account recorded on a sale or action identifies the signed-in user.

If sign-in fails, check the username or email, password, and whether the account is active. Passwords are not displayed to owners in Settings. Use the account recovery procedure maintained by the server administrator or developer; do not place passwords in the chatbot.

## Product catalog

Use the product catalog to create and maintain items that can be sold. Owners can search, add, edit, deactivate, and reactivate products. Product setup includes its name and SKU, unit, tax class, Generic or Branded type, selling price, and separate Senior Citizen and PWD benefit eligibility flags. Check all product fields against the store's source records before activating an item.

An inactive product is not offered for normal checkout. Deactivate a product when it should no longer be sold; do not delete or reuse a SKU to hide its sales or stock history. If a catalog was imported as a draft, entries may start inactive or unclassified. Review product type, tax class, unit, benefit flags, and price before making them available to cashiers.

The product catalog describes sellable products. A virtual bundle offer is configured separately and is not a stock-bearing product; see [Virtual bundle offers](#virtual-bundle-offers).

## Stock and receipt receiving

The **Stock** pages let an owner record opening stock, supplier receipts, physical count corrections, and write-offs, then inspect current quantity, stock value, and stock history. Use a reason when recording a correction or write-off so the history explains why the balance changed. The history records movements; it should be compared with a physical count when investigating a discrepancy.

For a product that is not lot-tracked, receive and adjust stock using the ordinary product workflow. For a lot-tracked product, record the actual batch or lot code, printed expiry date, and quantity from the package. At checkout, Medtryx assigns available tracked stock using first-expiry-first-out ordering (FEFO). The cashier must check the selected batch labels and confirm the physical lots before completing the sale.

Never invent a lot code or expiry date to make stock available. Existing stock without verified batch details can remain as unallocated legacy stock. If the product is lot-tracked, physically verify the actual packages and record a reasoned reconciliation before those units can be sold. If only part of the physical stock can be verified, leave the unverified part unallocated.

An owner can correct the current average acquisition cost for a product that has stock on hand. This requires a reason and revalues remaining units; it does not rewrite old supplier receipts or cost of goods already saved on completed sales. Enter the actual cost on future receipts. Inventory value and gross-profit displays should be treated as operational estimates and checked with the accountant's approved accounting process.

## Receiving a supplier receipt

The owner-only **Receipt receiving** workflow can extract suggested line items from an uploaded supplier receipt image or PDF. The receipt pages are sent to MixRoute for extraction. The workflow does not retain the uploaded pages after processing. Extraction is a convenience for preparing a draft; it is not an inventory transaction and its guesses must be reviewed.

1. Open **Receipt receiving** and upload the receipt pages.
2. Review the extracted supplier and line details. Correct SKU or product match, quantity, unit cost, package size, and any lot or expiry information against the original receipt and the product packaging.
3. Resolve unmatched lines by selecting an existing product or preparing a new catalog item. Review required POS fields for any new item before it is activated.
4. Check any package-to-piece conversion. Approve a conversion only when the package contents and supported selling unit are physically verified.
5. Review the prepared CSV and the full set of proposed lines. Import only after the product matches, quantities, cost, conversion, and lot details are correct.

Stock changes only when the owner approves and imports the reviewed receipt data. If the extraction is incomplete or unclear, correct it manually from the receipt or stop and ask the supplier or developer; do not import a guess. Keep the store's original supplier documents according to its own record-retention process.

## Checkout and sales

Cashiers search or scan active catalog products and add them to a browser cart. The server calculates the sale preview, including prices, taxes, and applicable discounts. Review the preview before finalizing. If a bundle is selected, the app expands it into its component products and checks component stock. For a tracked product, confirm the physical lot selection before completing the sale.

Checkout supports cash or a QR-declared payment. A QR declaration is a cashier's recorded payment type; Medtryx does not contact a bank, payment provider, or QR service to verify that funds arrived. Follow the store's separate payment confirmation process. Cash and QR are recorded differently for drawer reconciliation: QR sales do not add cash to the physical drawer.

Normal shift-based checkout requires the open shift to belong to the signed-in cashier account. A manually dated checkout can be recorded without an open shift, but it is not counted in a drawer shift's expected cash. Use that path only for an owner-approved manual or backdated sale.

Live sale finalization is blocked until the owner records the accountant-approved tax and acquisition-cost settings required by the application. A provisional assumption shown in a report is not an approval. The automated test database may use synthetic settings; those are not live business settings. Ask the owner/accountant to approve and record the proper values before live use.

Cashier cart changes are not a completed sale until the server confirms the sale. If a preview becomes stale because price, stock, policy, or offer details changed, refresh the preview and resolve the message before trying again. Do not repeat a sale just because the browser looks slow; first check the sale history or daily sales page to see whether the transaction was recorded.

## Cash register shifts and cash counts

Medtryx supports one open cash-register shift for the store. The shift is linked to the cashier account that opened it. That same account must be used for normal shift-based checkout; another cashier cannot open a second shift or use the first cashier's shift for normal checkout. If a different cashier needs to take over, close the current shift with the actual physical count, then open a new shift under the next cashier's account. Do not create another record or change a count to bypass the rule.

At close, count the physical cash and enter the actual amount. The app compares it with expected cash based on the opening float, cash sales, cash refunds, and recorded cash-in or cash-out activity. QR sales do not change expected drawer cash. Review the variance and record the required decision or explanation; never enter an invented count to force the variance to zero. Owners can inspect shift history, including who opened and closed a shift, times, opening amount, sales, refunds, expected amount, counted amount, and variance.

The expected value is a calculation from saved Medtryx events, not a physical count. It can be wrong if cash was not recorded promptly or activity happened outside the app. Investigate differences against the drawer, receipts, and approved store records. The shift history does not replace a separate site or bank reconciliation.

## Virtual bundle offers

Owners manage offers in **Bundles**. An offer has a unique code and name, active dates, component products and quantities, an optional maximum quantity per sale, and a promotional price. The owner can use a suggested reduction to prepare a price, edits the final amount, and must explicitly approve the offer price. Saving an edit creates a new version; earlier sales preserve the offer version used at that time.

A bundle is an offer that uses its component products. It has no independent stock balance or acquisition cost. Do not receive inventory against the bundle code or count it as a separate stocked product.

At checkout, select the offer and quantity. The app checks stock across all components and expands the sale into component lines. For lot-tracked components, review and confirm the selected physical lots. Review the promotional allocation and how it compares with any statutory discount. The more favorable allowed treatment is applied per component; discounts are not stacked. As a result, a statutory discount can make the final payable amount differ from the advertised bundle promotion. If dates, limits, price, or stock have changed, remove or reduce the offer and preview the cart again.

Bundle sales appear through their component lines in stock and reversal workflows, with the bundle discount shown separately in reports and exports. Follow the store's approved invoice process; the internal Medtryx record is not a substitute for an official invoice.

## Senior Citizen, PWD, and BNPC benefits

Product eligibility flags and policy settings affect what checkout can offer, but they do not establish legal eligibility. The owner/accountant must confirm current rules, store eligibility, covered products, and the procedure for verifying customer documentation before enabling a live policy. Do not infer eligibility from a product name, generic/branded type, or tax class.

The BNPC policy is versioned in Settings so a sale can keep a record of the policy used. Keep the live policy disabled until the store's responsible owner/accountant has reviewed the applicable official guidance and documented an approved procedure. Configure only products and values supported by that approval. Ask the owner/accountant—not the chatbot—to determine legal treatment or customer entitlement.

When an approved policy is enabled, the cashier must choose the appropriate benefit type and apply it only to eligible lines. Follow the store's checklist to inspect the relevant ID, booklet, authorization, and other required documents. Record only the data requested by the application. Medtryx cannot query purchases or discounts from other stores or online channels; a locally displayed remaining allowance cannot guarantee a customer's total use across channels. If required evidence is unavailable or uncertain, do not apply the benefit and follow the owner's escalation procedure.

Review the normal price, promotion, benefit calculation, tax, and final total in the server preview. The app records the policy and calculation used. An owner reversal offsets the local weekly use against the original week without altering the original sale. The owner Reports page displays customer names and ID numbers in its benefit transaction list, and access to that list is audited. The report CSV contains aggregate benefit totals rather than customer identifiers. Protect customer identity and never paste it into Owner help.

## Sale history, refunds, and reversals

Owners can search and inspect saved sales in sales history. Completed sale records are immutable. To correct an eligible completed sale, an owner uses the linked full-reversal or partial-refund workflow instead of editing or deleting the original sale. The owner must re-enter their current password, provide a reason, choose the refund method, and decide for each refunded line whether returned stock is sellable and should be restored or should be written off. Inspect returned packages before deciding to restock them. A sale can have one refund record, so review the quantities and method before approval.

A cash refund must be assigned to an available cash shift. A refund assigned to a closed original shift requires owner approval; expected cash can become negative after a refund, so count the actual drawer and reconcile it separately. QR refunds do not remove physical cash, but the owner should still follow the relevant payment provider's refund procedure separately. A reversal creates linked records and keeps the original sale and its calculation for audit history. If the sale is not eligible for reversal or the reason/stock condition is unclear, contact the owner or developer before taking action.

## Reports, daily sales, and CSV exports

Owner reports can be filtered by an inclusive Manila date range, including month-to-date, and exported for the same range as CSV. Check the selected start and end dates before comparing totals. The daily sales and journal views summarize saved sales and operational activity. Shift history reports the shared drawer's opening, closing, expected cash, count, and variance.

Stock and inventory value in reports are current balances, not historical stock snapshots for each past report date. Product gross-profit figures are estimates based on recorded sales and costs. They exclude operating expenses and benefit discounts, and tax treatment depends on the approved setting stored with the sale. Until approved tax settings are recorded, the UI may label a provisional assumption; do not use it as accounting advice or as an official tax report.

CSV exports are designed to avoid customer identifiers and to protect spreadsheet users from formula execution. Still, store exported files securely, share them only with authorized people, and use the approved accounting process for statutory reports. The app's internal sale record is not an official invoice.

## Journal, payments, and expenses

Use the journal and daily sales views to review the operational events recorded in Medtryx. Owners can review payments, expenses, and their history. Enter each cash-in, cash-out, payment, or expense in the relevant workflow with the actual amount, date, category, and explanation requested by the screen. Keep source receipts and supporting documents according to the store's accounting process.

These records support operational review; they do not by themselves prove that a payment cleared or that an expense is tax-deductible. Compare them with source documents and the accountant's records. If an entry is wrong, use the correction process available on the relevant page or contact the owner/developer; do not edit the database directly.

## Settings and activity history

Owner-only **Settings** includes user management and store/application configuration such as approved checkout policy. Some settings are versioned so past transactions retain the version that was applied. Before changing an operational or financial policy, confirm it with the responsible accountant and review its effective date and scope. Do not use test data or synthetic settings in the live environment.

The owner activity log records selected administrative actions for review. It helps answer who performed a recorded change and when, but it is not a substitute for complete source documents or physical verification. Keep owner accounts limited to trusted people because owner access includes sensitive management and recovery workflows.

## Backups and restore

Configure the store identity before relying on automated backups. Live backup setup requires absolute local paths outside the repository and two separately controlled storage locations. Medtryx verifies that backup packages are readable and that the two configured roots are separated according to its path and storage checks. Those checks cannot prove that two drives are physically independent; the owner must verify the actual media and protect both locations.

Create and verify both backup copies regularly, and check the latest successful result in **Backups**. Automatic live backups run daily after 02:00 Manila time after store identity has been configured. A backup package contains the SQLite database and the encryption key needed to recover protected SC/PWD identity data. Protect each package like sensitive customer information; restrict access to the service account and authorized administrators.

Restore requires owner reauthentication, confirmation of the store name, and a newly created verified safety backup of the current database. Restore replaces the live database with the selected backup; active sessions are revoked. Follow [Local installation and upgrades](#local-installation-and-upgrades) and `docs/DEPLOYMENT_AND_RECOVERY.md` for the full recovery procedure. Do not restore over live data just to inspect a backup; rehearse recovery on a separate copy.

## Local installation and upgrades

Medtryx is deployed on a local server. Development and test use separate SQLite databases under `data/` by default. Live deployment requires `APP_ENV=live` and an absolute `MEDTRYX_DATA_DIR` outside the repository. Do not copy a development or test database into live use. The live service is intended to bind only to loopback behind a local HTTPS proxy; do not expose the application server port directly to the network.

Database schema changes are delivered as SQL migrations. Apply them to the intended environment with `npm run db:migrate`, following the release-specific backup and recovery instructions. Before a live upgrade, make a verified backup and rehearse the migration and restore on a copy, especially for migrations that alter shifts, inventory lots, bundles, or benefit records. A migration failure can indicate that current records need owner reconciliation; do not delete records, invent counts, or edit SQLite directly to make it pass. Ask the developer to diagnose the migration using the error and a protected backup copy.

For current host requirements, environment variables, migrations, Caddy/HTTPS setup, and step-by-step recovery, follow `docs/DEPLOYMENT_AND_RECOVERY.md` and the README. Keep `.env`, API keys, encryption keys, database files, and backup packages out of source control and away from general shared folders.

## Owner help chatbot: answers, limits, and privacy

The owner-only **Owner help** chatbot answers questions about Medtryx using relevant sections of this guide. It supports DeepSeek V4 Flash 0731 as the default model, Qwen 3.6 Flash, and Gemini 3.5 Flash-Lite through MixRoute. The selected guide sections are included in the answer request so the chatbot can cite the relevant topic. If MixRoute determines that the guide does not contain enough detail, the Medtryx server performs a read-only search of selected application source files and sends a small set of matching excerpts to MixRoute. Code excerpts are cited with their file paths and line numbers. If neither source supports an answer, the chatbot should say it cannot confirm and direct the owner to a developer.

The code search is restricted to application source under `apps/web/src`, `apps/server/src`, `packages/shared/src`, and SQL migrations under `database/migrations`. Automated test files are excluded. It does not search `.env` files, databases, backups, dependencies, generated files, or build output. The chatbot does not query the live database, inspect store records, run shell commands, execute the source code, or take actions in Medtryx. It cannot change products, stock, sales, settings, files, or code. Chat messages remain in the current browser page state and are not saved by the Medtryx application.

The fallback needs those source directories to be present on the local server. If a deployment contains only compiled build output, the guide still works, but source lookup may return no matching excerpts.

To answer, the Medtryx server sends the owner's question, recent chat turns, and selected sections of this guide to MixRoute using the configured `MIXROUTE_API_KEY`. If the guide is insufficient, the server also sends the selected source-code excerpts. Do not enter customer names or IDs, passwords, API keys, encryption keys, receipt images, private supplier information, or other secrets. Choose a model according to the store's approved provider/privacy requirements. The chatbot gives workflow guidance, not medical, legal, tax, accounting, or policy approval.

If a workflow changes, update this guide with the implemented behavior so chatbot answers stay current. If the guide does not cover a question, verify it with the relevant page or developer rather than treating a guess as fact.

## Page-by-page manual

Use the Medtryx left navigation to open a page. The sidebar can be collapsed on desktop or opened from the menu button on a small screen. The selected page appears in the top breadcrumb. Navigation items are filtered by role; owner pages are hidden from cashiers and are also protected by the server. Use **Log out** when finished. The root URL opens **Checkout**. `/ledger` redirects to **Journal**, and `/stock/checkout-overrides` opens the corresponding section on **Stock**.

### Sign in (`/login`)

Sign in with the email address or username and password assigned to your individual staff account. There is no public registration form. Too many failed sign-in attempts may temporarily be rate-limited. The page shows a generic error for an incorrect identifier/password or inactive account. If a password was just changed, sign in again with the new password. Ask an administrator or developer about account recovery; the chatbot cannot reset credentials.

### Checkout (`/checkout`)

Use **Checkout** for a sale being made now. The cashier needs an open shift associated with the same signed-in cashier account. The app has one store-wide open shift, so a different cashier must wait until that drawer is counted and closed before opening a shift under their own account.

Search by product name, SKU, or barcode. Add an active product and choose its quantity, or select an active bundle offer. Change quantities or remove cart lines before saving. The cart is held in the current browser until the sale is confirmed. The server preview is authoritative: review each price, tax, discount, bundle allocation, stock warning, lot allocation, and payable amount before finalizing.

When configured for a lot-tracked product, verify the physical batch labels and confirm the assigned lot quantities. If the owner enabled checkout stock-count overrides, a shortage can be accepted only with the required physical count evidence; the shortage is recorded with the sale. This setting does not override expiry or quarantine restrictions. If override is off, checkout must stay within recorded saleable stock.

Choose the customer benefit type and apply a benefit only to eligible lines under the store's approved procedure. Enter protected customer details only in the designated checkout fields, never in chat. Choose cash or QR-declared payment. For cash, enter the amount received and review change. QR is only a recorded payment declaration; verify the funds separately. Finish the sale once and wait for confirmation. If the page stalls, check **Daily sales** or ask the owner to check **Sales history** before trying again.

### Manual checkout (`/manual-checkout`)

Use **Manual checkout** to enter a sale that was made during a system outage. Enter the original Manila business date; reports use that date, while inventory updates when the saved sale is entered. The page still applies the current approved tax policy and current stock rules. It does not use checkout stock-count overrides. Follow the owner's outage procedure and enter only a sale supported by the store's original records. Manual checkout does not belong to an open cash-register shift, so it does not update a drawer's expected cash.

### Daily sales (`/daily-sales`)

Choose a Manila business date and refresh to review that day's sales and related cash activity. Summary cards show transaction count, total sales, cash and QR amounts, expenses, stock purchase/COD payments, and payer totals. The page includes shifts with sales, product totals, and transaction details. Use **Group products by item** to switch between aggregated product quantities and transaction-by-transaction detail. Owners see store totals; cashiers see their own allowed shift and product information. Fully reversed sales are excluded from daily totals and product quantities. This page is for review; it does not edit or export the sales records.

### Journal (`/journal`, legacy `/ledger`)

The owner-only **Journal** copies daily sales summaries into monthly or yearly views. Select a month or year and refresh. A row is red until it has been reviewed and saved. After a Manila business day ends, select **Edit** to correct that journal row's month/date, invoice number range, senior discount, non-VAT sales, VATable sales, total VAT, gross sales, or net sales. Press **Save** to record the journal copy or **Cancel** to discard the draft. A journal edit changes only the journal entry; it does not change a sale, inventory, or receipt.

### Payments & Expenses (`/expenses`)

Choose a history date to review existing entries. New entries are recorded for today's Manila business date. Categories are **Lunch**, **Stock purchase / COD**, **Delivery fee only**, and **Other**. Other requires a description. Stock purchase entries can include product amount, optional separate delivery fee, supplier, and invoice/receipt reference; the page displays the combined payment total. Delivery-only entries can be marked as already included in product unit cost.

For stock purchase and delivery categories, select whether the cashier or owner paid. A cashier-paid payment requires an open drawer and changes its expected cash; an owner-paid entry does not change the drawer. Stock purchase/COD payments are excluded from operating expenses because stock cost is recognized through inventory/COGS. Recording the payment does not receive stock or change unit cost. Use **Stock** or **Receipt receiving** separately. Review the history table's payment amount, operating-expense amount, payer, recorded time, and recorder.

### My account (`/account`)

This page shows the signed-in email and role and lets each user change their own password. Enter the current password, a new password of at least 8 characters, and the same value again to confirm. A successful change signs out all active sessions for that account; sign in again with the new password. Owners cannot see another user's password here.

### Products (`/products`)

The owner-only catalog searches product name, SKU, or barcode. Sort a column by selecting its header, use **Show or hide columns** to adjust the table, and use pagination to view additional rows. Cost, stock value, price spread, and gross-profit estimates are owner-only catalog information; verify their calculation notes before using them for accounting.

Use **Add a product** to create a SKU and set its name, unit, selling price, reorder level, tax class, Generic/Branded/N/A type, SC/PWD eligibility, BNPC eligibility/category, and lot tracking. A zero-rated tax class is unavailable unless the approved tax policy allows it. Starting stock can be entered with its actual unit cost and, for tracked products, the opening lot, expiry, and supplier/reference information. If Medtryx suggests a possible duplicate, confirm whether this is an existing item; selecting an existing product receives stock against that SKU instead of creating a duplicate. Use **Edit** to update catalog details. Deactivate a product to remove it from normal checkout while preserving history; use delete only when the app says the product is eligible, because its history is retained and some records prevent deletion.

The page has three CSV tools. **Import new products from CSV** creates products with opening stock; **Update products from CSV** updates only columns supplied for matching SKUs; **Export product data CSV** downloads catalog details. Use each downloadable sample as a template. Imports are validated as a whole before saving, accept at most 500 rows and 200 KB, and report row errors. Product update CSV cannot change stock, cost, or gross-profit estimates; use **Stock** for inventory movements.

### Stock (`/stock`)

The owner-only **Current stock** table searches by name, SKU, or barcode and shows quantity, saleable/unallocated quantities when lots apply, reorder status, costs, and value. Select a product to use the action panels. **Receive stock** adds an actual receipt quantity and unit cost, supplier/reference, and required batch/expiry details for tracked products. Existing-SKU stock CSV import accepts up to 500 rows and 200 KB and validates the complete file before it changes stock.

Use **Correct acquisition cost** only to correct the weighted-average unit cost for stock still on hand. Enter the correct cost and a reason; past receipts and completed-sale COGS stay unchanged. **Adjustment or write-off** records a signed quantity change with a reason. Increases require a unit cost. Removing tracked stock requires selecting the actual lot; adding tracked stock requires actual batch and expiry details. Review **Stock history** to find receipts, adjustments, write-offs, sales, reversals, and actors.

The **Lots and expiry** table searches product/SKU/batch, shows physical and saleable counts, expiry alerts, unit cost, selling price, and status. Set the near-expiry warning horizon in days. Use **Quarantine** or **Release** only with a reason. Use **Edit lot** to correct physical quantity, cost, selling price, or expiry with a reason; these edits affect the applicable current lot/product balances. A lot's expiry is its last saleable day; an expired or quarantined quantity is not saleable. The `#checkout-count-overrides` section shows checkout stock-count override history. Verify a mismatch physically and keep unsupported legacy quantity unallocated instead of inventing a batch.

### Receipt receiving (`/receipt-receiving`)

The owner-only page uses an upload, review, and import workflow. Upload supplier receipt pages as supported images or PDF. MixRoute extracts draft line suggestions; extraction may miss, merge, or misread values. Review the supplier, SKU/product match, package name, quantity, unit cost, conversion to the product's selling unit, lot code, and expiry against the original receipt and package labels. Remove irrelevant lines and fix incomplete details. For a new product, enter and review its catalog/POS fields. Approve package conversions only when package contents and unit conversion are verified. Review the prepared CSV and import only when all lines are accurate. The import records stock; uploading or extracting alone does not. The uploaded pages are sent to MixRoute and are not retained by this workflow.

### Bundles (`/bundles`)

The owner-only **Bundle offers** page creates and maintains promotional offers. Enter a unique code, name, active start/end dates, component products and quantities, optional per-sale limit, and final promotional price. Price suggestions can be prepared using a percentage or fixed reduction, but the owner must review and explicitly approve the final price before saving. Editing makes a new immutable offer version; earlier sales keep their original offer snapshot. Activate/deactivate an offer when its availability changes. The offer is not a product with stock or cost of its own. Checkout consumes the component products and applies the offer subject to the saved promotion and statutory-discount rules.

### Sales history (`/sales`)

The owner-only **Sales history** page lists recent internal transactions or sales for a selected Manila date. Choose the record limit, use the day pagination controls, and select **Review** to see the saved sale, line prices, discounts, cost snapshots, lots, bundle version, and past changes. Original sale records remain intact.

For an eligible sale, choose a full refund or enter partial refund quantities per line; zero means the product stays sold. If a partial return comes from a line allocated across multiple lots, identify quantities returned from each original lot. Review the prorated refund total and rounding. Choose the actual refund method, provide a reason, reauthenticate with the current owner password, and decide whether each returned item is saleable/restocked or written off. A cash refund is assigned to a selected eligible cash drawer; closed-shift refunds need owner approval and can change that shift's expected cash/variance. QR refunds do not change physical cash, but must still be processed through the payment provider separately. Each sale can have one refund record, so confirm the returned quantities and method carefully.

When viewing a day, the page also allows an owner to cancel all eligible sales for that day after typing the date, entering a reason/password, and choosing whether all returned items are saleable. It skips sales already reversed or partially refunded. The page lists pending non-zero cash variances; enter the current owner password and a decision note, then approve or reject each variance. **Open cash drawers** lets the owner select a drawer and record a cash-in/out amount with a reason. Recheck the physical cash and the selected drawer before saving.

### Reports (`/reports`)

The owner-only **Sales reports** page uses an inclusive Manila start/end date range with Today, Month to date, Year to date, Refresh, and Export CSV controls. The report includes sales/tax/discount and reversal metrics, daily summaries, expense and stock-purchase payments, transaction corrections, benefit transactions, bundle promotion snapshots, and current low-stock products. Current inventory count/value and low-stock figures are the current balances, even when the selected sales period is in the past.

The benefit section displays Senior Citizen/PWD customer names and ID numbers to owners; access to that list is recorded in the audit history. Keep the screen private and limit exports/sharing. The report CSV is designed not to include customer identifiers and uses safe spreadsheet values. Reports are operational summaries, not an official invoice, tax filing, or accounting determination. Check the selected dates and the report notes before comparing totals.

### Product movement (`/product-movement`)

The owner-only **Product movement** page summarizes movement over a selected Manila date range. Use the start/end dates and refresh, then search by product name or SKU and filter **All**, **Fast**, or **Slow** products. The results show sold/returned/net units, average units moved per day, transaction count, last sale date, and current on-hand quantity. “Fast” and “Slow” are the app's classifications for the selected period; use the underlying counts and source records when making purchasing decisions. This view does not place supplier orders or change stock.

### Shift history (`/shifts`)

The owner-only **Shift history** page lists newest shifts first and can load older pages. It shows open/closed state, opening and closing users/times, opening cash, cash and QR sales/refunds, cash-in/out, expected cash, actual count, variance, and cashier reason. Use **Refresh** after a drawer action. QR amounts are visible but excluded from physical expected cash. Compare the record with the actual drawer count and approved reconciliation before resolving a variance.

### Activity log (`/activity-log`)

The owner-only **Activity log** provides an audit view, not an edit form. Choose Today, 7 days, 30 days, or All time; search a product, SKU, transaction, user, or reason; set a Manila date range; filter by area, user, and one or more actions; then select **Apply filters**. Leaving action boxes unchecked includes all actions. Use **Clear filters**, **Refresh**, and pagination to review results newest first. This log contains recorded events only; it is not a replacement for supplier receipts, sales documents, or physical counts.

### Backups (`/backups`)

The owner-only **Backups and restore** page sets the store name/identity that appears in backup manifests and reports backup readiness: environment, encryption key, primary/secondary paths, device separation, and latest automatic backup. Once both configured locations are ready, select **Create backup now** for a verified copy and refresh the status to inspect the result. Check both primary and secondary copies; do not treat a package as valid if its badge says verification failed.

To restore, select a verified package and copy, confirm the displayed store name, enter the current owner password, and select **Restore and sign out**. The server makes a verified safety backup of current data first, then replaces catalog, sales, shifts, settings, and audit history and revokes all staff sessions. Confirm that the package belongs to this store and rehearse on a separate copy before restoring live data. Backup packages are unencrypted and contain the customer data encryption key, so keep them in restricted locations.

### Settings (`/settings`)

The owner-only **Settings** page has several separate panels. In **Staff accounts**, create an individual owner or cashier account with email, username, temporary password, and role; deactivate/reactivate existing users when access changes. A username may contain letters, numbers, periods, underscores, and hyphens. Passwords are not shown again after account creation. The page also shows recent protected account activity; use the full **Activity log** for broader filtering. The last active owner cannot be deactivated.

In **Tax and acquisition-cost policy**, enter the policy version, VAT and benefit rates, VAT-inclusive price behavior, allowed zero-rated products, tax and cash rounding, approval reference, and approved supplier-cost basis. Confirm this was approved by the pharmacy's tax adviser/accountant, then record the policy. Without an approved policy, checkout previews are provisional and live sale finalization is blocked. Later policy versions are preserved with transactions; do not enter assumed values just to unlock sales.

In **BNPC 5% benefit policy**, review the official source, effective date, review date, weekly purchase and discount limits, minimum kinds, no-carryover rule, store eligibility, and approval reference. The percentage is fixed at 5%. Save creates a new immutable version. Enabling for live checkout requires owner review and accountant confirmation; leave it off until the store's current eligibility and exact procedure are approved.

In **Checkout inventory**, the owner can enable or disable physical stock-count overrides. If enabled, cashiers may attest physically available stock when recorded saleable stock is short; the confirmation is saved with the sale, while expiry and quarantine restrictions remain. Use the link to **Review checkout count overrides** on **Stock** to inspect these events. Enable only with a written count-control procedure.

### Owner help (`/owner-assistant`)

The owner-only help page lets you choose DeepSeek V4 Flash 0731 (default), Qwen 3.6 Flash, or Gemini 3.5 Flash-Lite. Type a question and press Enter or **Ask**; Shift+Enter starts a new line. Suggested questions cover stock receiving, backups, checkout blocks, and cashier access. Answers include **Sources** chips so you can see the guide section or source file/line range used. Use **Clear chat** to erase the visible conversation; leaving the page also clears the browser-only chat. The bot cannot view live data or change the application. Questions, guide excerpts, and (only when needed) selected source code go to MixRoute; never paste sensitive store or customer details.

### Redirects and unavailable pages

`/` opens Checkout. `/ledger` is an older address that redirects to Journal. `/stock/checkout-overrides` redirects to the checkout override history section on Stock. An unrecognized route redirects to Checkout. If a page appears missing for a cashier, the page may require the owner role; if an expected owner page is absent, refresh and ask the developer to check the deployed release.

## Common problems

- **A product is missing at checkout:** Ask an owner to confirm it exists, is active, and has enough available stock. Check the exact SKU and unit.
- **Stock is lower than expected:** Review the stock history, receipt imports, sales, reversals, and write-offs, then compare with a physical count. Record corrections with evidence and a reason.
- **A lot-tracked item cannot be sold:** Check the actual lot quantity, expiry, allocation status, and the physical lot confirmation step. Do not invent batch details or bypass an expired/insufficient lot warning.
- **Checkout is blocked by policy settings:** An owner must record the accountant-approved tax and acquisition-cost policy. Do not use provisional values as a workaround.
- **Checkout says another shift is open:** Use the existing shared store shift or have the owner reconcile and close it with a physical drawer count. The store supports only one open shift.
- **Expected cash differs from the drawer:** Count the physical cash again and review cash sales, refunds, cash-in/out, and opening float. QR sales do not change drawer cash. Record the actual count and investigate the variance.
- **A QR payment is uncertain:** Check the payment provider using the store's approved process. A QR-declared Medtryx sale is not proof of settlement.
- **A receipt extraction looks wrong:** Compare every line with the original receipt and product packaging. Correct or remove inaccurate suggestions before importing.
- **An owner cannot restore a backup:** Check owner reauthentication, store-name confirmation, the verified safety backup, disk access, and the recovery procedure. Preserve backup files and contact the developer if verification fails.
- **The chatbot says it cannot answer:** The current guide may not cover the question. Ask a developer to verify the code and update this guide. Do not enter secrets or customer data while trying to get a more specific answer.
