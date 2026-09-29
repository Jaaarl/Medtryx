# Medtryx — Simplified Web Product and Technical Specification

**Status:** Proposed replacement scope for a first web release  
**Market:** One pharmacy in the Philippines  
**Primary interface:** Responsive web app for a desktop, laptop, or tablet browser  
**Source:** Simplified from [Medtryx Product and Technical Specification](Medtryx_Product_and_Technical_Specification.md)

> This is a new product direction, not an amendment to the original mobile specification or its feature files. Tax, discount, invoicing, privacy, and any system registration requirements must be checked with the pharmacy's accountant and the appropriate authorities before production use.

## 1. Product in one paragraph

Medtryx is a browser-based pharmacy sales and simple stock system. The owner creates inventory products and maintains stock. Cashiers select existing products for checkout, record sales, and apply approved Senior Citizen (SC) or Person with Disability (PWD) treatment to eligible items. A sale reduces stock automatically. The pharmacy continues to issue its registered manual invoice separately. Medtryx records the declared payment method but does not collect or verify payment.

### First-release goals

1. Let a cashier complete a sale quickly in a browser.
2. Keep a reliable quantity on hand for each product.
3. Calculate tax and SC/PWD discounts by sale line, including mixed carts.
4. Give the owner simple daily sales, stock, cash, and estimated gross-profit summaries.
5. Keep a clear history of who changed products, stock, and finalized sales.
6. Work on the pharmacy's local network without an internet connection, provided the store computer and network are running.

## 2. What changes from the original specification

| Area | Original direction | This first release |
| --- | --- | --- |
| App | Kotlin/Compose app on a HUAWEI tablet, plus a separate iPad dashboard | One responsive web app opened in a browser on any approved device |
| Server | Tablet hosts the data and dashboard | One store computer hosts the web app and database |
| Product setup | Many product attributes, effective-date versions, and pack conversions | One simple SKU record with required name, unit, price, tax class, generic/branded type, and separate SC/PWD eligibility |
| Inventory | Lot-level ledger, expiry dates, automatic lot allocation, pack conversion | One quantity on hand per SKU; simple stock-in and adjustment history |
| Acquisition cost | Lot/cost snapshots and more detailed margin reporting | Record the unit acquisition cost on each stock receipt; show a weighted-average cost and estimated unit profit per SKU |
| Expiry | Digital lot and expiry warnings and automatic exclusion from sales | Staff check expiry on the physical product; expired items are removed with a stock adjustment |
| Bundles and special promotions | Included in the larger plan | Deferred |
| Customer devices | Special iPad pairing and tablet-hosted dashboard | Same browser app with role-based screens |

The original specification remains available for later features. Its implementation-status notes do not describe the status of this proposed web app.

## 3. Scope of the first release

### Included

- Individual staff accounts with cashier and owner permissions.
- Owner-only product creation and editing; cashier product search during checkout; optional barcode field.
- Opening stock, stock received with unit acquisition cost, and manual stock adjustments.
- Checkout with cash or QR as a **declared** settlement method.
- VATable and catalog VAT-exempt products, with zero-rated products only if the owner has an approved reason to use that class.
- SC/PWD treatment on individually selected, eligible sale lines.
- Automatic, unique **Medtryx Transaction ID**.
- Full-sale void/reversal with owner approval and reason.
- Basic cashier shift and cash count.
- Owner sales reports for an inclusive Manila date range, including a month-to-date shortcut, payment-method and discount totals, current stock and estimated gross profit; CSV export for the same dates.
- Backup, restore, and a separate test environment or test database before live use.

### Deferred

- Lot or batch numbers, expiry-date database, automatic earliest-expiry allocation, expiry alerts, and recall-by-lot reports.
- Packs-to-pieces conversion, multiple selling units sharing one stock pool, and lot-specific or FIFO cost allocation.
- Bundles, promotional discounts, BNPC 5% discount, partial returns, supplier purchasing, and full accounting/expense reports.
- Payment gateway, QR verification, official invoice generation, electronic invoicing, and customer-facing receipts.
- Multi-branch synchronization, public online ordering, and a browser offline mode.

Deferring a feature means staff need an operating procedure for it. In particular, the browser must not claim that it has checked a medicine's expiry or lot when it has not.

## 4. Users and main screens

| Role | Can do |
| --- | --- |
| Cashier | Sign in, open/close the store's single cash-register shift, search **existing active products** and add them to a checkout cart, make sales, see stock availability and selling prices, record cash or QR declaration. Cannot create or edit an inventory product. |
| Owner | Everything a cashier can do, plus create/edit/deactivate inventory products, receive/adjust stock, view acquisition cost and profit estimates, approve voids, review shift opening/closing history and cash reconciliation, view reports, export data, and manage users and backups. |

An optional read-only role can be added if someone needs report access without editing rights. All protected actions are checked on the server, not only hidden in the browser interface.

Main screens: **Login**, **Checkout**, **Products**, **Stock**, **Sales History**, **Shift Close**, owner-only **Shift History**, **Reports**, and **Settings/Backup**. Cashiers search the catalog from **Checkout**; product creation and stock management screens are owner-only. The same checkout works on desktop and tablet widths; large touch targets and keyboard/barcode-scanner input are supported where available.

## 5. Products: minimum useful catalog

Each SKU represents one product in **one stock and selling unit**. For example, a SKU may be stocked and sold as `tablet`, `bottle`, or `box`. Staff enter stock in that same unit. Selling ten tablets means quantity `10` of a tablet SKU. Automatic box-to-tablet conversion is outside this release.

| Field | Rule |
| --- | --- |
| SKU | Required, unique, and never reused. Generated by Medtryx if staff do not provide one. |
| Product name | Required; displayed in search and on internal sale records. |
| Barcode | Optional; unique if provided. |
| Unit | Required; e.g., tablet, bottle, box, piece. Fixed after stock or sales exist. |
| Selling price | Required, in Philippine pesos; VAT-inclusive where applicable. |
| Acquisition cost | Entered for opening stock and each receipt, not as one permanent product price; current average cost is calculated from the stock on hand. |
| Catalog tax class | Required: `VATABLE` or `VAT_EXEMPT`; `ZERO_RATED` only when enabled and approved. |
| Product type | Required radio selection: `GENERIC` or `BRANDED`. This descriptive classification does not determine tax class or benefit eligibility. |
| Senior Citizen eligible | Required yes/no checkbox, reviewed by an authorized person. |
| PWD eligible | Required yes/no checkbox, reviewed by an authorized person. The two eligibility flags are independent and may both be selected. |
| Quantity on hand | Stored whole-unit count; changed only by stock operations or finalized sales. |
| Reorder level | Optional; used for a simple low-stock list. |
| Active | Inactive products cannot be added to new sales; old sales remain visible. |

The owner confirms each product's tax class, generic/branded type, and SC/PWD eligibility against the pharmacy's approved source. The app must never infer these values from a product name or from the word “medicine.” Senior Citizen and PWD eligibility are checked independently during checkout. Changing price or classification affects future sales only; each finalized sale keeps a copy of the values used at checkout. A product with history is deactivated rather than deleted. Product creation, editing, deactivation, and CSV import require owner permission on the server. Existing records from before generic/branded classification remain unclassified until an owner reviews them; old combined SC/PWD eligibility migrates as eligible for both benefits to preserve prior behavior.

For initial setup, support manual product entry. A **simple CSV import** may be included if the starting catalog is large. Its columns include product fields, opening quantity, and opening unit acquisition cost; it has a preview, duplicate-SKU checks, row errors, and explicit confirmation. The import has no lot, expiry, or multiline pack fields.

## 6. Inventory: quantity and acquisition cost per product

### Stock actions

1. **Opening stock:** Owner enters a counted quantity and its unit acquisition cost when a SKU is created or the store is initialized.
2. **Receive stock:** Owner enters SKU, quantity, **unit acquisition cost**, and an optional supplier/reference note. Stock increases. A new receipt may have a different cost from earlier receipts; the product's selling price stays the same until the owner changes it.
3. **Sell:** Finalizing a sale decreases each SKU by its sold quantity.
4. **Adjust stock:** Owner enters the actual correction quantity and a required reason such as count correction, damage, or expiry disposal. An increase needs a unit acquisition cost; a decrease removes value at the current weighted-average cost.
5. **Void sale:** An owner-approved full reversal restores stock only if the physical item is sellable and returned to stock. A damaged or disposed item is recorded as not restored.

The product screen shows the current quantity. A separate stock history shows every increase or decrease with SKU, signed quantity, acquisition cost when applicable, action, reference, actor, timestamp, and reason when required. The current quantity and inventory value are updated in the **same database transaction** that writes the stock history and any related sale. Negative stock is blocked. A low-stock list compares current quantity with the optional reorder level.

### Acquisition cost and unit profit

The **selling price** belongs to the SKU. The **unit acquisition cost** belongs to each opening-stock entry or receipt, because the same SKU can be bought at different prices. Keep the cost on each receipt in history; later receipts must not rewrite earlier costs or prior sales. This is cost tracking, not lot or expiry tracking: Medtryx cannot identify which physical batch a sold unit came from.

For the MVP, use a **moving weighted-average cost** for units of the same SKU. When new stock arrives:

```text
new inventory value = old inventory value + (received quantity × receipt unit cost)
new quantity        = old quantity + received quantity
average unit cost   = new inventory value ÷ new quantity
```

Example: 10 units acquired at ₱40 and 10 more at ₱50 leave 20 units with an average cost of ₱45. If the current selling price is ₱70, the simple **unit price spread** is `₱70 − ₱45 = ₱25`. The subtraction runs from selling price to acquisition cost, not the other way around.

On the owner inventory screen, show **current selling price**, **latest acquisition cost**, **weighted-average unit cost**, **estimated unit price spread**, **estimated unit gross profit at regular price**, **quantity**, and **inventory value**. The gross-profit estimate uses normal-sale revenue excluding output VAT minus average unit cost; it assumes no customer discount. Show each receipt's acquisition price and its spread against the *current* selling price so the owner can compare deliveries. Cashiers see selling price and available quantity, not acquisition cost or profit. These figures exclude other operating expenses. Require a cost for stock entered into the live system; a genuine zero-cost receipt needs a reason.

At sale finalization, snapshot the weighted-average cost used for each sold line and calculate its cost of goods sold (COGS). Allocate rounded centavos so the remaining inventory value plus allocated COGS still equals the value before the sale; set inventory value to zero when quantity reaches zero. For a sellable full-sale reversal, return stock at the **original sale's allocated cost**, not today's average cost. An expired/damaged removal reduces inventory value and appears as a separate write-off, not as a sale.

For management reports, define **estimated gross profit = sale revenue after discounts and excluding output VAT, minus allocated COGS**. A regular sale with no discount may therefore show a different gross-profit figure from the inventory screen's simple price spread. The pharmacy's accountant should approve the cost basis used for acquisitions, including the treatment of supplier VAT and other purchase costs, before treating this report as an accounting figure. This choice of weighted average is consistent with the cost-formula options described in [IAS 2](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ias-2-inventories.pdf?bypass=on); VAT collected on behalf of government is excluded from revenue under the relevant [IFRS for SMEs revenue guidance](https://www.ifrs.org/content/dam/ifrs/supporting-implementation/smes/2025-modules/module-23.pdf).

### Manual expiry procedure for the first release

- On receipt, staff inspect and organize medicine batches and expiry labels outside Medtryx.
- Before handing over a medicine, staff check the physical pack's expiry date. The web app cannot verify this.
- Staff separate expired or damaged items from saleable stock and record the removed quantity as an adjustment with a reason.
- Staff keep any required batch, expiry, supplier, recall, or disposal records in their existing paper or external process.

This design **does not provide lot traceability or automatic expiry protection**. If the pharmacy needs those capabilities for its operations or compliance, they become a go-live requirement instead of a later enhancement.

## 7. Checkout, tax, and SC/PWD treatment

1. Cashier searches or scans an existing active inventory product, **adds it to the checkout cart**, enters a whole-unit quantity, and sees the price and available stock. This does not create or edit the product in inventory.
2. Cashier chooses `REGULAR`, `SENIOR_CITIZEN`, or `PWD` for the sale.
3. For SC/PWD, cashier records the customer's name, ID type, and ID number, confirms checking the physical ID, and selects **only the eligible lines** receiving the benefit.
4. Medtryx calculates and shows each line's tax, discount, and amount due, then the total.
5. Cashier declares `CASH` or `QR`. QR is a staff declaration, not payment verification.
6. Cashier confirms the sale. Medtryx saves the sale and stock deductions together, then assigns a unique internal transaction ID.

The pharmacy is assumed to be VAT-registered and to use VAT-inclusive prices, as stated in the original specification. The rate, approved rounding rule, and product classifications must be confirmed before live use. Use decimal/integer-centavo money calculations; never use binary floating point for stored monetary values. Store each line's price, tax class, benefit selection, calculation, and applied rule at the time of sale so later edits do not change history.

Tax-component rounding and cash-total rounding are separate approved settings. When the owner selects **nearest ₱0.25**, round the combined final CASH amount using these centavo ranges; keep each saved line's tax and due amount unchanged. QR-declared totals stay exact. Save the signed difference between the line total and cash total on the sale, use the rounded sale total for the shift's expected cash, and preserve the same difference in a full-sale reversal so the original paid amount is refunded. Show cash rounding adjustments as a separate report metric, offsetting them when a reversal is recorded; do not add them to line tax, net-sales, or estimated-gross-profit figures.

| Final cash total ending | Rounded cash total |
| ----------------------- | ------------------ |
| `.00–.12`               | `.00`              |
| `.13–.37`               | `.25`              |
| `.38–.62`               | `.50`              |
| `.63–.87`               | `.75`              |
| `.88–.99`               | next `.00`         |

The pharmacy's owner/accountant must approve this treatment before enabling it for live sales.

For an approved SC/PWD-qualified VATable line, remove the VAT component from the VAT-inclusive price before calculating the applicable 20% statutory discount. For a catalog VAT-exempt qualified line, apply the approved discount without removing VAT again. An unselected or ineligible line remains a regular line. Do not combine SC and PWD benefits on the same line. Show the calculation to staff so it can be transcribed into the separate manual-invoice process.

These rules carry forward the original specification's core calculation, which should be reviewed against [RA 9994](https://lawphil.net/statutes/repacts/ra2010/ra_9994_2010.html) and [BIR RR 5-2017](https://ncda.gov.ph/disability-laws/implementing-rules-and-regulations-irr/revenue-regulations-no-5-2017-rules-and-regulations-implementing-republic-act-no-10754/) before release. Staff must use the pharmacy's approved eligibility and documentation procedure.

### Internal sale record

The app generates an ID such as `MTX-20260927-000123`. Staff do not enter the manual invoice number. Every on-screen or exported transaction summary is labeled **INTERNAL SALES RECORD — NOT AN INVOICE**. The pharmacy issues and manages its registered manual invoice outside Medtryx. The owner must confirm the system's invoicing and registration treatment before go-live; the internal label does not settle that question. See the [BIR registration requirements](https://www.bir.gov.ph/registration-requirements-details) and the original specification's invoicing references.

## 8. Voids, shifts, and reports

**Voids:** A finalized sale is never edited or deleted. The owner reauthenticates, enters a reason, and creates a linked full-sale reversal. The reversal offsets sales totals and handles stock according to whether the item is physically sellable. Partial returns and exchanges are deferred.

**Shifts:** Only one shift (the store's single cash register) may be open at a time across all cashier accounts. The opening cashier records opening cash, then closes with an actual cash count. Expected cash is opening cash plus cash sales minus cash refunds and recorded cash-out, plus any recorded cash-in. QR-declared sales do not enter expected physical cash. Show the variance and require a reason for a non-zero variance; owner approval may be required by store policy. Owners can review opening/closing account names and times, opening float, cash and QR sales, refunds and cash movements, expected cash, actual count, and variance. Cashier access remains limited to their own current shift.

**Reports:** Select inclusive start and end dates in the `Asia/Manila` time zone; a one-day range remains the daily view, and **Month to date** selects the first of the current Manila month through today. Show gross and net sales, VATable and VAT-exempt amounts, VAT, SC and PWD discounts separately, cash and QR declarations, reversals, COGS, estimated gross profit, current/low stock, and inventory value. Attribute sales to their saved Manila business date; attribute reversals and cash movements to their event date. Current stock and inventory value are current balances, not historical end-of-period balances. Export a formula-safe CSV for the same selected range. Reports are internal records and must reconcile to stored sale, reversal, and stock records. Keep stock write-offs separate from COGS and gross profit.

## 9. Web architecture and deployment

```text
Desktop / laptop / tablet browser
             |
          HTTPS
             |
One Medtryx web server on a store computer
  - serves the responsive interface
  - authenticates users and checks permissions
  - calculates sales and changes stock
  - stores the single-store database
  - creates backups and exports
```

**Recommended first deployment:** Run one web server on an always-on store computer, with staff devices connected through the pharmacy's private local network. The app can function during an internet outage as long as the server and local network remain available. It does not keep an offline browser copy of sales. If the store computer or local network fails, staff use the existing manual procedure and reconcile later under an owner-controlled process.

The exact framework is an implementation choice. A conventional web frontend, one server-side application, and one relational database are enough for one store. SQLite is a reasonable initial database on a single server if its backup and concurrent-sale behavior are tested; a larger database can be chosen if deployment needs it. Tax, discount, permission, and stock rules live on the server. Finalization uses a database transaction and a uniqueness constraint on the transaction ID. Use HTTPS even on the local network, secure session cookies, password hashing, idle timeout, and server-side permission checks.

If the pharmacy prefers a cloud-hosted site instead, decide that **before implementation**: it changes internet dependency, hosting, backup, privacy, and access controls. The checkout features stay the same.

### Minimum data records

- `User` and role.
- `Product` with current quantity, inventory value, selling price, and classification.
- `StockEvent` for opening, receipt (including unit acquisition cost), sale, adjustment, and restoration.
- `Sale` and immutable `SaleLine` calculation and allocated-cost snapshots.
- `SaleReversal` linked to the original sale.
- `Shift` and cash count.
- `AuditEvent` for protected actions.
- `Setting` for approved tax/rounding and store details.

Use server timestamps stored in UTC and `Asia/Manila` for daily reports. Protect SC/PWD names and ID numbers, restrict report access, and keep them out of ordinary logs and exports unless explicitly needed. The [Data Privacy Act](https://privacy.gov.ph/data-privacy-act/) requires appropriate protection of personal information.

### Backup and recovery

Create a daily **unencrypted** backup in an access-restricted folder on the server and keep a second copy on separate trusted storage controlled by the owner. Include the database, any key needed to read protected customer fields after restore, and a manifest with store identity and backup date. Do not put backup files in a public download or shared network folder. Only the owner can start a restore. Show the backup date and store identity before restoring, make a safety copy of current data, and test a complete restore before launch. Document who can access backup files and how staff resume after a server failure.

## 10. Acceptance criteria for a first pilot

1. A cashier can add an **existing active inventory product to the checkout cart**, choose quantity, and finalize a cash or QR-declared sale from a browser; the cashier cannot create a new inventory product.
2. Two cashiers cannot both sell the last available unit; one transaction succeeds and the other receives a stock warning.
3. Sale and stock deduction either both save or both roll back after an error.
4. Opening stock, receipts at different unit costs, sales, adjustments, and sellable-item voids produce a readable stock history and the expected current quantity and inventory value.
5. A mixed cart applies SC/PWD treatment only to selected eligible lines, and approved centavo examples match exactly.
6. Product price or tax changes do not alter prior sales or reports.
7. A cashier cannot create, edit, or deactivate an inventory product, import products, edit stock, change classifications or prices, or change finalized sales through the interface or direct API calls. Only the owner can create inventory products.
8. An approved void remains linked to the original sale and does not erase it.
9. Inclusive Manila date-range reports reconcile saved sales and reversal activity across date boundaries; CSV totals match the selected interval, cash totals exclude QR declarations, and current stock is clearly labeled as a current balance.
10. A second receipt at a different cost changes the average cost but does not silently change the selling price or any earlier sale's cost snapshot.
11. An access-restricted backup can be restored into a clean test environment with matching sales, stock, inventory-value totals, and readable authorized customer records.
12. Staff can use checkout on the actual planned desktop/tablet browsers and the pharmacy's private network.
13. The owner confirms the acquisition-cost basis, manual expiry/lot procedure, tax rules, invoice process, and any required system registration before live use.
14. At most one cashier shift can be open store-wide, including when separate cashier accounts attempt to open simultaneously; a cashier can open after the active shift closes.
15. Owners can review shift opener/closer accounts and times, drawer amounts and cash reconciliation; cashier accounts cannot access the owner history endpoint.
16. With owner-approved nearest-₱0.25 cash rounding enabled, checkout rounds the combined CASH total by the documented table, leaves QR totals and line tax unchanged, and preserves the signed adjustment through sale, full reversal, expected shift cash, reports, and CSV.

## 11. Decisions to make before development or launch

| Decision | Proposed default | Needed by |
| --- | --- | --- |
| Hosting | One store computer on the private local network | Before development |
| Catalog setup | Manual entry, then a simple CSV import if product count warrants it | Before catalog build |
| Stock unit | One fixed unit per SKU; whole quantities | Before data entry |
| Acquisition-cost basis | Owner/accountant defines which supplier taxes and purchase costs belong in unit cost | Before entering opening stock |
| Barcode input | USB/Bluetooth scanner acting as keyboard, or manual search | Before checkout testing |
| Void/return policy | Owner-approved full reversal only | Before checkout release |
| Cash variance approval threshold | Owner approval for every non-zero variance until configured | Before shift testing |
| Backup destination and access owner | Unencrypted backup in a restricted server folder plus a separately stored copy | Before pilot |
| Lot/expiry operations | Physical inspection and external records | Before pilot; promote to software scope if required |
| Tax, SC/PWD, rounding, and invoicing rules | Owner and professional review of current requirements | Before live use |

## 12. Later enhancements, only if the pharmacy needs them

Add lot and expiry tracking when staff need batch-level traceability, automated expiry blocking, or recall reports. That future module would record lots at receipt, choose a lot at sale, and report balances and expiry by lot. Other possible additions are packs-to-pieces conversion, partial returns, promotions, bundles, supplier purchasing, cloud access, and multiple branches. Each addition should be justified by an actual workflow and tested against the simpler first-release data.
