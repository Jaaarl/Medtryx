# Medtryx Pharmacy Sales and Inventory System

## Product Requirements and Technical Specification

**Status:** Draft for implementation and compliance review  
**Research reviewed:** September 23, 2026  
**Primary market:** Philippines  
**Primary device:** HUAWEI MatePad 11.5  
**Proposed client technology:** Kotlin and Jetpack Compose

> This document combines the product owner's concept with the client's operational, tax, discount, inventory, reporting, and control requirements. It is a software specification, not legal or tax advice. Before production use, the pharmacy should have its accountant/tax adviser and BIR Revenue District Office confirm the invoicing, registration, rounding, retention, and report requirements for the specific taxpayer.

---

## 1. Product Summary

Build **Medtryx**, a local-first pharmacy sales and inventory system for an Android-compatible tablet. It records sales and the customer's declared settlement method, but it does not process card, cash, or QR payments itself.

Medtryx must:

- record internal sales while the pharmacy handles registered manual invoices outside Medtryx;
- maintain inventory and deduct stock when a sale is finalized;
- calculate item-level VAT, Senior Citizen (SC), Person with Disability (PWD), and authorized discounts correctly;
- preserve separate tax and discount classifications;
- support mixed carts where only selected items receive SC/PWD treatment;
- manage cashier profiles, shifts, cash turnover, voids, and audit trails;
- support time-limited product bundles without corrupting component tax treatment or stock;
- generate daily and monthly reports and CSV/Excel-compatible exports;
- run offline on the primary tablet;
- host a secure local web dashboard that an iPad can open over the pharmacy's local network; and
- provide isolated test data and test workflows before live use.

Medtryx does not integrate with a payment gateway or cash drawer and does not issue the official invoice in the first release. The pharmacy will handle registered manual invoices separately. For the MVP, the cashier will **not** enter a manual invoice series or number in Medtryx. Medtryx will automatically assign an internal transaction ID that is not an invoice number.

---

## 2. Product Goals

1. Make pharmacy checkout fast and usable on a tablet.
2. Make every financial result traceable to line-level inputs and rules.
3. Prevent a customer-level discount from being applied blindly to an entire cart.
4. Keep historical sales unchanged when a product's current price, cost, tax class, or discount eligibility changes.
5. Work during an internet outage.
6. Give the owner a simple iPad dashboard for sales viewing, backup, and export.
7. Protect sensitive customer, cashier, tax, and sales data.
8. Automatically identify every internal sale without requiring the cashier to type an invoice number.

## 3. Explicit Non-Goals for the First Release

- Payment processing, QR verification, e-wallet APIs, card terminals, or banking reconciliation.
- E-prescribing, telemedicine, patient medical records, or medical advice.
- Automatic legal determination from a product name alone.
- Generation of the official BIR invoice, electronic invoicing, receipt printing, or automatic submission to BIR EIS.
- Multi-branch real-time cloud synchronization.
- Supplier purchasing and accounts payable beyond receiving stock and recording cost.

---

## Feature Map and Traceability

Standalone implementation specifications are collected in the [feature documentation index](features/README.md). This master document remains the primary product source of truth; intentional changes must update the affected feature file as well.

| Feature ID | Feature | Primary specification section | Delivery phase |
|---|---|---|---|
| [F01](features/F01-users-authentication-permissions.md) | Users, authentication, and permissions | Section 4 | Phase 1 |
| [F02](features/F02-product-catalog-import-configuration.md) | Product catalog, CSV import, and configuration | Section 6 | Phase 1 |
| [F03](features/F03-tax-money-discount-engine.md) | Tax, money, and discount engine | Section 7 | Phase 1 |
| [F04](features/F04-sc-pwd-checkout.md) | SC/PWD checkout | Section 8 | Phase 1 |
| [F05](features/F05-sales-settlement-transaction-ids.md) | Sales, settlement declaration, and internal transaction IDs | Section 9 | Phase 1 |
| [F06](features/F06-inventory-lots-expiry.md) | Inventory, lots, and expiry | Section 10 | Phase 1 |
| [F07](features/F07-product-bundles.md) | Product bundles | Section 11 | Phase 2 |
| [F08](features/F08-cashier-shifts-turnover.md) | Cashier shifts and cash turnover | Section 12 | Phase 1 |
| [F09](features/F09-voids-returns-corrections.md) | Voids, returns, and corrections | Section 13 | Phase 2 |
| [F10](features/F10-reports-exports-audit.md) | Reports, CSV export, and audit reports | Section 14 | Phase 2 |
| [F11](features/F11-backup-restore-recovery.md) | Encrypted backup, restore, and recovery | Section 18 | Phase 2 |
| [F12](features/F12-isolated-test-mode.md) | Isolated Test Mode | Section 19 | Phase 2 |
| [F13](features/F13-local-ipad-dashboard.md) | Secure local iPad dashboard | Section 15 | Phase 3 |

Each feature must meet its row in the feature test matrix in Section 20. A delivery phase is complete only after its implementation work and phase test gate both pass.

---

## 4. Feature F01 — Users, Authentication, and Permissions

### 4.1 Cashier

- Sign in with an individual profile and PIN.
- Open and close only their own shift.
- Create regular, SC, and PWD sales.
- Select eligible cart lines for a statutory discount.
- Record settlement method as `CASH`, `QR`, or another admin-enabled method.
- View only the operational information needed for checkout.
- Cannot change selling price, tax classification, discount eligibility, or finalized transactions.

### 4.2 Pharmacist or Supervisor

- Perform cashier actions.
- Validate prescription-related requirements where configured.
- Approve controlled operational exceptions assigned to this role.
- Review stock movements and discrepancy reasons.

### 4.3 Administrator or Owner

- Manage users, products, prices, tax classifications, stock, bundles, and settings.
- Approve a protected price override if the business enables it.
- Void, reverse, or correct a transaction using a fresh admin authentication step and a reason.
- View reports, backups, exports, audit history, and shift variances.
- Configure business identity and internal transaction settings.

### 4.4 Auditor or Read-Only User

- View internal sales records, reports, audit history, and exports.
- Cannot change business data.

All actions must be attributed to one authenticated user. Shared cashier accounts are prohibited.

---

## 5. Important Domain Decisions

### 5.1 Tax class and discount eligibility are different data

Each SKU must have both:

1. a **catalog tax classification**; and
2. one or more **discount/benefit eligibility rules**.

A medicine being eligible for an SC/PWD benefit does not mean every sale of that SKU is automatically VAT-exempt. Conversely, a medicine may already be VAT-exempt under the Tax Code regardless of the buyer. The system must store the reason for the actual treatment applied to each sale line.

### 5.2 Tax is line-level, not transaction-level

A mixed cart may contain VATable, VAT-exempt, and zero-rated lines. One exempt or SC/PWD-qualified line must never make unrelated lines exempt.

### 5.3 SC and PWD are separate reporting types but share the core pharmacy formula

For covered medicines and goods, current rules grant qualified SC and PWD customers a 20% discount and VAT exemption, when applicable, for their exclusive use and enjoyment. They must remain separate transaction types because identification, reporting, and audit records are separate. A customer who qualifies as both may use only one statutory benefit on the same sale, not two stacked 20% discounts. See [RA 9994](https://lawphil.net/statutes/repacts/ra2010/ra_9994_2010.html), [BIR RR 7-2010](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/10/55830), and [BIR RR 5-2017](https://ncda.gov.ph/disability-laws/implementing-rules-and-regulations-irr/revenue-regulations-no-5-2017-rules-and-regulations-implementing-republic-act-no-10754/).

### 5.4 Manual invoices remain outside the MVP

In the first release, Medtryx does **not** generate, number, validate, or track the official manual invoice. The pharmacy handles the registered manual invoice as a separate process. The cashier is not asked to encode its number. Medtryx automatically creates an internal transaction ID, and any on-screen or exported transaction summary must be labeled **INTERNAL SALES RECORD — NOT AN INVOICE**.

[RA 11976](https://lawphil.net/statutes/repacts/ra2024/ra_11976_2024.html) requires invoices for covered sales and requires VAT-registered sellers to invoice every sale. [BIR RR 7-2024](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%207-2024%20%28final%29.pdf) implements the invoicing rules. Those obligations remain with the pharmacy's separate manual process. Calling Medtryx an internal tool does not itself determine its regulatory treatment; the business remains responsible for obtaining professional guidance where required.

---

## 6. Feature F02 — Product Catalog, Import, and Configuration

Every sellable SKU must include:

| Field | Requirement |
|---|---|
| SKU/internal ID | Immutable unique identifier |
| Barcode(s) | Optional, multiple allowed |
| Product name | Required |
| Generic name | Optional |
| Brand | Optional |
| Strength | Optional |
| Dosage form | Optional |
| Inventory/sales unit | Required per SKU; every product is listed individually with its own unit, such as tablet, capsule, bottle, box, or piece |
| Pack conversion | Optional per SKU; use only when that specific product is received by pack but stocked/sold by an individual base unit |
| Selling price | Required; store in centavos or exact decimal, never floating point |
| Cost per unit | Optional but required for margin reports |
| Catalog tax class | `VATABLE`, `VAT_EXEMPT`, or `ZERO_RATED` |
| Tax basis/source | Reason or authority for the classification |
| Tax effective dates | `validFrom` and optional `validTo` |
| Benefit eligibility | `SC_PWD_20`, `BNPC_5`, `OTHER`, or `NONE`; allow rule versioning |
| Prescription class | `PRESCRIPTION`, `OTC`, or configured local classification |
| Active status | Active/inactive; products referenced by history cannot be deleted |
| On-hand quantity | Derived from inventory movements |
| Reorder level | Configurable |
| Lot/batch | Required for received medicine stock in the MVP; optional for non-expiring retail goods |
| Expiry date | Required per medicine lot; optional only for products that do not expire |
| Supplier reference | Optional |

Cashiers may not change tax class, benefit eligibility, or selling price. These actions require an explicitly granted protected permission that may be assigned to an owner, administrator, pharmacist, or supervisor. Every change must record the old value, new value, user, timestamp, reason, and effective date.

The MVP must support both individual product entry and bulk CSV import for the starting catalog and opening inventory. CSV import requires a protected role, a validation preview, duplicate-SKU/barcode detection, row-level errors, and explicit confirmation before committing any records. The importer must reject malformed UTF-8, oversized files, wrong row widths, duplicate headers, invalid values, and changed source data between preview and commit. A reviewed subset may be committed only after explicitly selecting valid rows. For multiple opening medicine lots on one SKU, use one quoted multiline `opening_lots` cell with one `lot | YYYY-MM-DD | quantity | optional supplier` record per line; the legacy single-lot columns may be used for a one-lot row.

Catalog edits preserve the immutable SKU identity and inventory unit. Protected pricing, tax, and benefit changes create effective-dated versions, close the previous version at the day before the new start where applicable, and record actor, reason, effective date, and old/new values. The prescription/OTC classification is persisted with the product. Lot/expiry requirements cannot change while stock remains on hand; a unit conversion or stock reclassification requires a separately reviewed inventory operation.

The product master controls each SKU individually. Do not infer `medicine = VAT-exempt`. The Tax Code contains specific VAT-exempt medicine categories, and applicable medicine lists can be updated. See [RA 11534](https://lawphil.net/statutes/repacts/ra2021/ra_11534_2021.html) and the BIR's [RMC 59-2025 update](https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2059-2025.pdf). Importing a verified FDA/BIR list may be added later, but changes must require review rather than silently rewriting the catalog.

---

## 7. Feature F03 — Tax, Money, and Discount Engine

### 7.1 Required inputs per sale line

- SKU and quantity.
- VAT-inclusive unit price captured at time of sale.
- Catalog tax class captured at time of sale.
- Discount eligibility captured at time of sale.
- Selected benefit type, if any.
- Whether this line is selected as qualified for the benefit.
- Rule version and rate used.
- Authorized manual or promotional discount, if any.

### 7.2 Required computed values per line

- Gross line amount before statutory VAT removal or discount.
- VAT-exclusive base.
- VAT amount for a regular VATable sale.
- VAT removed because of an SC/PWD-qualified sale, if applicable.
- Statutory discount amount.
- Promotional or other authorized discount amount.
- Net line amount due.
- Applied tax result: `VATABLE`, `VAT_EXEMPT_CATALOG`, `VAT_EXEMPT_SC`, `VAT_EXEMPT_PWD`, or `ZERO_RATED`.
- Applied discount result and authority.

### 7.3 Money and rounding

- Use Philippine pesos.
- Use integer centavos or `BigDecimal`; never `Float` or `Double` for stored financial calculations.
- Calculate using at least four internal decimal places and round displayed/stored monetary totals to two decimal places.
- Adopt one documented line-level rounding rule and use it consistently in the app, manual invoice, export, and reports.
- Require one authorized owner, administrator, pharmacist, or supervisor to approve the production rounding rule during setup; record the approver and timestamp.
- Persist the unrounded basis, rounded result, rule version, and tax rate so totals can be reproduced.

### 7.4 Regular VATable line

Assuming the displayed retail price is VAT-inclusive and the current VAT rate is 12%:

```text
gross             = unitPrice × quantity
vatExclusiveBase  = gross ÷ 1.12
vatAmount          = gross - vatExclusiveBase
amountDue          = gross
```

### 7.5 Catalog VAT-exempt line

```text
gross             = unitPrice × quantity
vatExclusiveBase  = gross
vatAmount          = 0
amountDue          = gross
```

### 7.6 SC/PWD-qualified VATable line

For a VAT-registered seller and an eligible purchase:

```text
gross                  = unitPrice × quantity
discountBase           = gross ÷ 1.12
vatExemptionAdjustment = gross - discountBase
statutoryDiscount      = discountBase × 20%
amountDue               = discountBase - statutoryDiscount
```

BIR RR 5-2017 illustrates a VAT-inclusive sale of ₱1,120 becoming a VAT-exclusive base of ₱1,000, followed by a ₱200 discount and an ₱800 amount due. The engine must not subtract 12% and then 20% directly from the original gross as if both percentages had the same base.

### 7.7 SC/PWD-qualified line already VAT-exempt in the catalog

Do not remove VAT a second time:

```text
gross                  = unitPrice × quantity
discountBase           = gross
vatExemptionAdjustment = 0
statutoryDiscount      = discountBase × 20%
amountDue               = discountBase - statutoryDiscount
```

### 7.8 Non-VAT-registered seller

VAT removal does not apply for a non-VAT-registered seller. The discount basis and percentage-tax accounting differ from a VAT-registered seller, and BIR RR 5-2017 provides a separate non-VAT illustration. This deployment is confirmed as `VAT_REGISTERED`; the value is an administrator-protected store setting and is never selected by the cashier.

### 7.9 Mixed-cart example

Assumptions:

- Paracetamol: ₱100.00, catalog `VATABLE`, eligible for SC benefit, selected as qualified.
- Shampoo: ₱150.00, catalog `VATABLE`, not selected and not qualified.
- Customer benefit: `SENIOR_CITIZEN`.
- Seller: VAT-registered.

```text
Paracetamol VAT-exclusive base     ₱ 89.29
VAT not billed on qualified line     10.71
SC discount (20% of ₱89.29)          17.86
Paracetamol amount due               71.43

Shampoo VATable sales               133.93
Shampoo VAT                          16.07
Shampoo amount due                  150.00

TOTAL AMOUNT DUE                    ₱221.43
```

The shampoo remains a normal VATable sale. If the exact paracetamol SKU is catalog VAT-exempt under an applicable medicine list, its calculation instead follows Section 7.7.

### 7.10 Benefit stacking and promotions

- Never stack SC and PWD discounts on the same line.
- Never silently stack a statutory benefit with a promotional discount.
- Where rules require the customer to receive the more favorable applicable discount, show both outcomes and apply the permitted selection with an audit record.
- Keep `OTHER_AUTHORIZED_DISCOUNT` configurable by rate, tax interaction, validity dates, approval requirement, and legal/business basis.
- Do not implement "Other" as an unrestricted percentage button.

### 7.11 BNPC 5% special discount

The 5% Basic Necessities and Prime Commodities program is distinct from the 20% medicine benefit and generally does not carry the same VAT exemption. DTI guidance also includes purchase limits and documentation rules. Because covered goods and limits can change, model this as a separate, versioned policy—not as the SC/PWD 20% rule. See the DTI's [BNPC guidance](https://www.dti.gov.ph/dti-news-archived/dti-senior-citizens-and-persons-with-disabilities-can-avail-of-a-5-discount).

Include BNPC support in the MVP behind an administrator-only on/off switch. Keep it **off by default** until the covered SKU list, current cap, booklet handling, and rule version are configured and approved. Turning it off prevents new BNPC discounts but does not alter historical transactions.

### 7.12 Calculation snapshots and domain contract

The F03 implementation uses integer-centavo `Money` values at its boundary and `BigDecimal` quantities with at most four fractional digits. The caller must provide an approved rounding rule with an ID, version, mode, approver, and approval timestamp; no implicit production rounding default is selected. VAT-exclusive division uses 12 internal decimal places before line outputs are rounded to cents.

Each immutable line calculation snapshot captures the SKU price and quantity, price/tax/benefit effective dates, catalog tax source and benefit classifications, selected benefit and line qualification, tax/discount rule IDs and versions, rates, unrounded gross and VAT-exclusive bases, rounded outputs, rounding approval, and applied discount authorization/authority/reason. F05 must store these snapshots atomically with finalized sale lines so later configuration changes cannot alter history.

The engine applies SC/PWD VAT removal only when that benefit is selected for the specific eligible line. An alternative promotion calculation remains a normal VATable sale unless the captured rule explicitly provides otherwise. Promotion stacking is explicit and rejected unless the captured promotion permits it and any required protected-role authorization is present. BNPC remains disabled unless its approved version includes effective dates, covered SKUs, rates, and SKU quantity caps; it never inherits SC/PWD VAT exemption.

F05 now persists the complete calculation snapshot with each sale line using a versioned codec, in the same Room transaction as the sale and inventory movements. Changes to current catalog or financial configuration therefore do not recalculate saved history.

---

## 8. Feature F04 — SC/PWD Checkout

1. Cashier adds products and quantities to the cart.
2. Cashier selects `NO_DISCOUNT`, `SENIOR_CITIZEN`, `PWD`, or an enabled authorized benefit.
3. For SC/PWD, require:
   - customer name;
   - benefit ID type;
   - ID number; and
   - cashier confirmation that the physical ID was checked.
4. Display each cart line with its tax class and benefit eligibility.
5. Allow the cashier to select only qualified lines. Ineligible lines cannot be selected without an authorized override and reason.
6. Recalculate and show:
   - gross amount;
   - VATable sales;
   - VAT;
   - VAT-exempt sales;
   - zero-rated sales;
   - VAT not billed because of the benefit;
   - discount; and
   - amount due.
7. Show a blocking confirmation:

   > **SC/PWD DISCOUNT WILL BE APPLIED. CONFIRM?**

8. Require the cashier to confirm the selected lines and customer details.
9. Show the final tax and discount breakdown for the pharmacy's separate manual-invoice process.
10. Require the cashier to confirm the sale; do not ask for an invoice number.
11. Automatically assign the next internal Medtryx transaction ID.
12. Finalize atomically: save the sale, sale lines, inventory movements, audit event, internal transaction ID, and settlement declaration together.

The MVP verifies the physical ID and stores the customer's name, ID type, and ID number because official record requirements refer to both name and ID number. It does not store an ID image. Prescription, purchase-booklet, ID-expiry, or representative fields are disabled unless the pharmacy later confirms that they are operationally required. PWD medicine purchases can have additional documentation requirements; review the DOH's [AO 2017-0008 guidance](https://ncda.gov.ph/disability-laws/administrative-orders/doh-ao-2017-0008-implementing-guidelines-of-republic-act-10754-otherwise-known-as-an-act-expanding-the-benefits-and-privileges-of-persons-with-disability-for/) before production use.

**Implementation status (2026-09-24):** Checkout now captures SC/PWD evidence, requires explicit eligible-line selection and confirmation, and encrypts the customer name and full ID with an Android Keystore AES-GCM key. JVM tests cover SC, PWD, mixed-cart, evidence validation, and redacted summaries. Compose UI and physical-device keystore/restart checks remain verification gates.

---

## 9. Feature F05 — Sales, Settlement, and Internal Transaction Recording

### 9.1 Sale states

```text
DRAFT -> AWAITING_CONFIRMATION -> FINALIZED
                                  -> VOIDED_BY_REVERSAL
                                  -> PARTIALLY_RETURNED
                                  -> FULLY_RETURNED
```

Finalized sales are immutable. A correction creates linked reversal and replacement records; it never edits or deletes the original.

### 9.2 Settlement declaration

Medtryx records, but does not process, settlement:

- `CASH`
- `QR`
- other admin-enabled methods

For QR, support an optional external reference and a cashier confirmation such as `CUSTOMER_SHOWED_SUCCESS`. Clearly label this as **unverified by Medtryx** unless a payment provider is integrated later.

### 9.3 MVP finalization workflow

1. Medtryx calculates the completed cart.
2. Medtryx displays the item, tax, and discount breakdown needed by the pharmacy's separate manual-invoice process.
3. The cashier confirms the customer type, qualified lines, settlement declaration, and amount due.
4. Medtryx assigns a unique internal transaction ID automatically.
5. Medtryx finalizes the sale and inventory movements in one database transaction.

The checkout screen must not show an invoice-number input. Medtryx does not validate, reserve, reconcile, or report manual invoice numbers in the MVP.

**Implementation status (2026-09-24):** Schema version 6 and additive migration 5→6 persist immutable sale headers, line snapshots, settlement declarations, transaction sequences, and lot allocations. The F05 use case writes sales, F06 ledger deductions, and finalization audit evidence atomically; CASH/QR declarations are supported and QR remains unverified. Automated rollback, idempotency, sequence, last-unit concurrency, FEFO, migration, and snapshot round-trip checks are in place. Physical MatePad restart/reboot and checkout UI verification remain phase gates.

### 9.4 Internal transaction numbering

- Generate the identifier automatically; the cashier cannot enter or edit it.
- Use an immutable UUID as the database identity and a human-readable sequence such as `MTX-20260923-000123` for staff searches.
- The human-readable ID must remain unique per store, work offline, and never be reused after a void.
- A void, return, or replacement sale keeps links to the original internal transaction ID.
- Clearly label the identifier as `Medtryx Transaction ID`, never `Invoice No.` or `Receipt No.`.

### 9.5 Internal transaction summary

Medtryx may display or export an internal transaction summary for operations and reconciliation. It must be labeled:

> **INTERNAL SALES RECORD — NOT AN INVOICE**

It must show the Medtryx transaction ID and must not use invoice branding, claim to be an electronic invoice, or be presented to the customer as a substitute for the registered manual invoice.

BIR [RMO 24-2023](https://bir-cdn.bir.gov.ph/local/pdf/RMO%20No.%2024-2023%20Digest%20FINAL.pdf) covers accreditation of POS and similar sales software. The project owner has classified Medtryx as an internal operational tool and electronic BIR invoicing is outside the MVP. This product decision must not be represented as a legal determination or as permission to replace any required books, invoices, or registrations.

---

## 10. Feature F06 — Inventory, Lots, and Expiry

Use an append-only inventory movement ledger. `onHand` is the sum of movements, not a freely editable number.

Required movement types:

- `OPENING_BALANCE`
- `RECEIPT`
- `SALE`
- `SALE_REVERSAL`
- `RETURN_SELLABLE`
- `RETURN_DAMAGED`
- `ADJUSTMENT_IN`
- `ADJUSTMENT_OUT`
- `EXPIRED`
- `BUNDLE_ASSEMBLY_IN`
- `BUNDLE_ASSEMBLY_OUT`

Every movement must store SKU, quantity, unit, lot/expiry when applicable, cost snapshot, sale or source reference, user, timestamp, and reason.

Store movement quantities as signed base-unit values: incoming movements are positive and outgoing movements are negative. Protected receiving, adjustment, and expired-stock disposal require a reason and retain actor, timestamp, movement reference, and before/after stock evidence in the audit trail. Medicine adjustments identify a lot; lot balances cannot go negative. An expired lot is excluded from sale allocation and is reduced through an explicit `EXPIRED` movement after protected disposal. Reject receipt of already expired medicine stock. Low-stock warnings compare ledger-derived on-hand with the SKU reorder level. Near-expiry warnings use an explicitly selected store horizon; do not hard-code an undocumented warning period.

When a receipt is entered in packs, convert it using only that SKU's configured units-per-pack factor and record the resulting exact base-unit quantity. Reject a missing conversion factor or any conversion that would require rounding.

Rules:

- Finalizing a sale deducts inventory in the same database transaction as the sale.
- A failure rolls back both sale and stock changes.
- Negative stock is blocked by default and can only be enabled as an explicit audited business policy.
- Warn for low stock, expired stock, and near-expiry lots.
- Use an approved lot allocation method, preferably earliest-expiry-first when operationally feasible.
- A void or return restores stock only through a reversal movement and only if the item is sellable.

---

## 11. Feature F07 — Product Bundles

The preferred bundle is a **virtual sales bundle**, not a new stock count.

Example: Rainy Season Bundle = one umbrella + one paracetamol item.

Bundle fields:

- name and code;
- component SKUs and quantities;
- promotional price or discount allocation method;
- active start and end timestamps;
- active/inactive state;
- optional quantity limit;
- approval and audit metadata.

At checkout, explode the bundle into component sale lines. Deduct each component's inventory separately and retain each component's own tax class and SC/PWD eligibility. Allocate a bundle-level discount proportionally using pre-discount component prices unless an accountant-approved rule specifies otherwise. Never classify or discount the whole bundle based on one component.

If the pharmacy physically pre-packs bundles and wants a separate bundle stock count, use explicit assembly movements that consume components and create bundle stock. Do not maintain both component stock and bundle stock without those movements.

---

## 12. Feature F08 — Cashier Shifts and Cash Turnover

### 12.1 Shift opening

- Cashier signs in.
- Cashier enters opening cash float.
- System records device, user, and timestamp.
- A cashier may have only one open shift per device/store unless an admin-approved policy says otherwise.

### 12.2 Shift close

Calculate:

```text
expectedCash = openingFloat
             + finalizedCashSales
             + cashIn
             - cashRefunds
             - cashOut

variance = actualCashCount - expectedCash
```

QR sales do not enter expected cash. The cashier enters the physical cash count, optionally by denomination. Require notes for a non-zero variance and supervisor approval above a configurable threshold. Until an authorized threshold is configured, require separate supervisor approval for every non-zero variance. The amount remains an open configuration decision in Section 22.2.

The turnover report must include:

- shift/cashier identifiers;
- opening and closing timestamps;
- opening float;
- gross and net sales;
- cash sales;
- QR-declared sales;
- refunds, cash in, and cash out;
- expected cash;
- actual cash;
- variance;
- voids/reversals approved during the shift; and
- cashier and receiving supervisor acknowledgements.

Closed shifts are immutable. Corrections use adjustment records.

Implementation boundary: F08 records cash refunds against a linked reversal reference; F09 must connect approved void/return events to shift turnover, and F10 owns the report/export surface. These dependent integrations remain open until those features are implemented.

---

## 13. Feature F09 — Voids, Returns, and Corrections

- Require a fresh admin/supervisor authentication, not merely an already-unlocked screen.
- Require a reason from an admin-managed reason list plus optional notes.
- Never delete the original transaction.
- Generate a linked reversal document and opposite inventory/tax/report entries.
- Preserve who requested and who approved the action.
- Separate void-before-settlement, post-sale return, damaged return, and data-correction workflows.
- A price, tax class, or product update after the sale must not recalculate old sales.

---

## 14. Feature F10 — Reports, Exports, and Audit Reports

### 14.1 Daily and monthly reports

Show at minimum:

- total/gross sales;
- VATable sales;
- VAT;
- VAT-exempt sales, separated by catalog exemption and statutory SC/PWD treatment where useful;
- zero-rated sales;
- SC sales;
- PWD sales;
- SC discount granted;
- PWD discount granted;
- other discounts;
- net sales/amount due;
- quantity sold;
- cost of goods sold when cost is available;
- gross margin when cost is available;
- cash sales;
- QR-declared sales;
- Medtryx transaction ID for reconciliation;
- voids, returns, and corrections;
- inventory remaining;
- low-stock and near-expiry items; and
- shift variances.

### 14.2 Export

- Export UTF-8 CSV that opens correctly in Excel.
- Use stable column names and ISO 8601 timestamps with the store's Asia/Manila business timezone recorded.
- Escape spreadsheet formula prefixes (`=`, `+`, `-`, and `@`) in user-entered text to prevent CSV formula injection.
- Allow date range and report type selection.
- Include a schema/version field.
- Record every export in the audit log.
- Offer `.xlsx` only if a tested library preserves types and totals; CSV is the required baseline.

### 14.3 Audit reports

Provide dedicated reports for:

- price changes;
- tax-class changes;
- discount overrides;
- voids/returns;
- inventory adjustments;
- admin authentication events;
- backups/restores;
- exports; and
- failed login attempts.

---

## 15. Architecture and Feature F13 — Local iPad Dashboard

### 15.1 Architecture style

Use a single-device, offline-first system with a local web dashboard:

```text
HUAWEI tablet
  ├─ Jetpack Compose cashier/admin UI
  ├─ Domain services: pricing, tax, discount, inventory, shifts
  ├─ Room/SQLite primary database
  ├─ Encrypted backup/export service
  └─ Local HTTPS service
          └─ iPad Safari dashboard on the same private network
```

The database is the local source of truth. The web dashboard calls the same domain/application layer rather than duplicating tax logic in JavaScript.

Android recommends Room over direct SQLite for structured local persistence and migration support; see the [Room documentation](https://developer.android.com/training/data-storage/room). Use database transactions and foreign keys for finalization.

### 15.2 Suggested modules

```text
app-android
core-model
core-money
core-tax
core-discount
core-inventory
core-database
core-security
feature-auth
feature-catalog
feature-checkout
feature-shifts
feature-reports
feature-settings
local-server
web-dashboard
```

The tax and discount modules must be plain Kotlin with deterministic unit tests and no UI dependency.

### 15.3 Local server behavior

- Bind only to the private/local interface, never expose directly to the public internet.
- Start from a visible user action.
- Run as a foreground service with a persistent notification while hosting.
- Show server state, device name, local URL, connected clients, and a stop button.
- Stop automatically on logout, configured inactivity, or unsafe network changes.
- Use a pairing QR code with a short-lived, single-use token.
- Issue revocable sessions with role-scoped authorization.
- Rate-limit authentication and API calls.
- Use HTTPS in production. Plain HTTP is allowed only in test mode with synthetic data.

Android restricts background service starts and long-running background behavior; a tablet-hosted server must therefore be explicitly user-visible and tested against power management. See Android's [foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) and [background optimization guidance](https://developer.android.com/topic/performance/background-optimization).

For a fully local HTTPS setup, provision a per-install local certificate authority/certificate and install trust on the managed iPad, or use another reviewed certificate strategy. Do not add a "trust all certificates" bypass. Android documents both custom trust anchors and cleartext risks in its [Network Security Configuration](https://developer.android.com/privacy-and-security/security-config) and [cleartext communication guidance](https://developer.android.com/privacy-and-security/risks/cleartext-communications).

### 15.4 HUAWEI compatibility gate

The selected deployment device is a **HUAWEI MatePad 11.5, model BTKR-W09, with 8 GB RAM, 256 GB total storage, and HarmonyOS 4.2.0**, not stock Android. Before building the full application:

1. verify the reported model and exact OS build on the physical device;
2. install a minimal signed Kotlin/Compose APK;
3. verify Room, keystore, foreground service, local socket binding, file export, camera/barcode access, and app relaunch after reboot;
4. verify behavior with battery optimization and screen lock;
5. avoid dependencies that require Google Mobile Services; and
6. confirm the app-distribution/update method for that device.

If this compatibility spike fails, keep the domain and web code but either use a certified Android tablet or create a HarmonyOS-native shell. Do not assume all MatePad variants support the same Android runtime behavior.

---

## 16. Core Data Model

Suggested principal entities:

- `User`, `Role`, `Permission`, `Credential`
- `Shift`, `CashMovement`, `ShiftCount`, `ShiftApproval`
- `Product`, `ProductBarcode`, `ProductPriceVersion`, `TaxClassVersion`, `BenefitRuleVersion`
- `InventoryLot`, `InventoryMovement`
- `Bundle`, `BundleComponent`, `BundlePriceVersion`
- `Sale`, `SaleLine`, `SaleLineCalculation`, `SettlementDeclaration`
- `BenefitCustomer`, `BenefitEvidenceChecklist`
- `InternalTransactionSequence`
- `Return`, `ReturnLine`, `Reversal`
- `AuditEvent`
- `BackupManifest`, `ExportManifest`
- `AppSetting`, `BusinessRegistration`, `RuleSetVersion`

Important modeling rules:

- Use UUIDs internally and generate a separate unique, human-readable Medtryx transaction ID automatically.
- Snapshot product name, unit, price, cost, tax class, eligibility, rate, and calculation on each sale line.
- Store timestamps in UTC and store the business timezone used for presentation/report boundaries.
- Use append-only audit and stock ledgers.
- Apply soft deletion/inactivation to referenced master data.
- Put a schema version in the database, backups, internal summaries, and exports.

---

## 17. Security and Privacy

SC/PWD names and ID numbers are personal information; prescription-related data may be sensitive. The Philippine Data Privacy Act requires reasonable organizational, physical, and technical measures, data minimization, purpose limitation, and appropriate retention. See the National Privacy Commission's [Data Privacy Act text](https://privacy.gov.ph/data-privacy-act/) and [security guidance](https://privacy.gov.ph/data-security/).

Required controls:

- Encrypt sensitive data at rest using keys protected by the device keystore.
- Encrypt all production network traffic.
- Use unique accounts, strong PIN/password handling, progressive delay/lockout, and role-based access.
- Hash passwords/PINs with a password-specific algorithm and unique salts; never store plaintext credentials.
- Auto-lock after configurable inactivity.
- Redact customer IDs in ordinary screens and reports; reveal only to authorized roles.
- Export only encrypted backup packages to the user-selected tablet folder; never expose the raw database.
- Encrypt backups with an independent recovery passphrase/key.
- Keep secrets out of logs, CSV diagnostics, and crash reports.
- Maintain a privacy notice, retention schedule, incident process, and authorized-access policy.
- Log access to sensitive reports and exports.
- Avoid collecting ID images, birth dates, diagnoses, or prescription photos unless a confirmed rule and retention policy require them.

---

## 18. Feature F11 — Backup, Restore, and Recovery

- Support a manual encrypted full backup to a user-selected folder visible in the tablet's file manager, using Android's system file picker.
- Use a default suggested location such as `Documents/Medtryx Backups`, subject to what HarmonyOS exposes through its file picker.
- The iPad dashboard may request a backup, but the tablet remains responsible for creating and storing it.
- Each backup contains a manifest with schema version, app version, store ID, creation time, record counts, and cryptographic checksum.
- Never write an unencrypted database copy to shared storage.
- Verify the backup after writing.
- Restore only after admin authentication and a compatibility check.
- Before restore, create a recoverable safety backup of the current database.
- Provide a restore preview with source store, date, version, and counts.
- Record backup and restore events in the audit log.
- Test restore, not only backup creation, before go-live and periodically afterward.

Keeping the only backup on the same tablet does not protect against device loss, theft, or storage failure. The MVP supports the requested local file-manager destination, but the owner should periodically copy the encrypted backup to a separate trusted device or drive.

Recommended recovery targets for the first deployment:

- Recovery point objective: no more than one business day, improved to each closed shift if backups are performed then.
- Recovery time objective: restore and verify within two hours.

---

## 19. Feature F12 — Isolated Test Mode

Test Mode must use a physically separate database and a visibly different internal transaction-ID prefix. It must never write to live inventory, reports, customer records, backups, or totals.

All screens, exports, and artifacts must display `TEST MODE` prominently.

Required scenarios:

1. Regular VATable sale.
2. Catalog VAT-exempt sale.
3. Zero-rated sale when enabled.
4. SC sale on a VATable qualified item.
5. SC sale on an already VAT-exempt qualified item.
6. PWD sale on a VATable qualified item.
7. PWD sale on an already VAT-exempt qualified item.
8. Mixed VATable and VAT-exempt cart.
9. Mixed regular and SC/PWD-qualified lines.
10. Attempted discount on an ineligible line.
11. Attempted SC + PWD stacking.
12. Promotional versus statutory discount selection.
13. Bundle containing differently taxed components.
14. Cash and QR settlement declarations.
15. Void, partial return, full return, and damaged return.
16. Inventory deduction and reversal.
17. Shift opening, turnover, and variance.
18. Device reboot and app recovery.
19. iPad disconnect/reconnect and expired pairing token.
20. Backup, checksum verification, and restore.
21. Database migration from the previous released version.
22. CSV export with commas, Unicode, and formula-like user text.
23. Automatic, unique internal transaction IDs across normal sales, voids, app restarts, and device reboots.
24. Administrator back-entry of an internal sale after a documented tablet outage, with original sale time and a mandatory reason.

The tax engine must have table-driven unit tests with exact expected centavo results. Finalization, inventory movement, internal transaction-ID generation, and reversal require integration tests.

---

## 20. Feature Test Matrix and Minimum Acceptance Criteria

### 20.1 Required tests by feature

#### F01 — Users, authentication, and permissions

- Unit-test role and permission decisions for cashier, owner, administrator, pharmacist, supervisor, and auditor.
- Integration-test login, logout, inactivity lock, failed-attempt throttling, credential changes, and fresh authentication for protected actions.
- Verify at the use-case/API layer that a cashier cannot change prices, tax classes, eligibility, stock, rounding, BNPC state, finalized sales, or backups even if the UI is bypassed.
- Pass condition: every protected action is denied to unauthorized users and every successful protected action is audited.

#### F02 — Product catalog, import, and configuration

- Unit-test SKU validation, units, tax/eligibility enums, pack conversion, price/cost precision, lot requirements, and effective dates.
- Integration-test manual entry and CSV preview/import, including duplicate SKU/barcode, invalid enum, missing field, malformed number, mixed valid/invalid rows, and rollback.
- Migration-test catalog schema changes without losing historical references.
- Pass condition: imported and manually entered products produce equivalent valid records, and invalid input cannot partially corrupt the catalog.

#### F03 — Tax, money, and discount engine

- Use table-driven exact-centavo tests for regular VATable, catalog VAT-exempt, zero-rated, SC, PWD, mixed-cart, promotion comparison, already-exempt plus 20%, quantity, and rounding-boundary cases.
- Property-test invariants such as non-negative totals, component sums matching transaction totals, no double VAT removal, and order-independent cart totals under the approved rounding rule.
- Versioning-test that changing a current rule never changes a stored historical calculation.
- Pass condition: all approved examples match to the centavo with no `Float` or `Double` in the persisted calculation path.

#### F04 — SC/PWD checkout

- UI-test ID type/number, customer name, physical-ID confirmation, qualified-line selection, and the blocking confirmation dialog.
- Test mixed eligible/ineligible carts, no selected eligible line, attempted SC/PWD stacking, and an unauthorized eligibility override.
- Verify that no ID image, prescription image, or unapproved extra personal data is collected.
- Pass condition: only explicitly selected eligible lines receive the chosen benefit, and required customer/ID audit data is stored.

#### F05 — Sales, settlement, and internal transaction IDs

- Integration-test atomic finalization, rollback after injected failure, cash/QR declaration, optional QR reference, and internal summary labeling.
- Test ID uniqueness across concurrent attempts, voids, app restart, database reopen, and device reboot.
- UI-test that no manual invoice-number field exists and internal output says `INTERNAL SALES RECORD — NOT AN INVOICE`.
- Pass condition: a sale and all dependent records either commit together or do not exist, and no transaction ID is reused.

#### F06 — Inventory, lots, and expiry

- Unit-test signed movement and on-hand derivation, low-stock state, explicit near-expiry horizon, expired state/disposal, non-lot aggregate stock, and earliest-expiry-first allocation including expired-lot exclusion and equal-expiry ordering.
- Integration-test authorized receiving, lot-scoped adjustments, wrong-SKU lot rejection, cost snapshots, movement/audit evidence, negative-stock blocks, and expired disposal.
- F05 must integration-test sale deduction and last-unit concurrency inside atomic finalization. F09 must integration-test reversals and sellable/damaged return disposition.
- Verify medicine receipts require a future expiry date and lot/batch.
- Pass condition: the ledger always reconciles to displayed stock; no sale may commit without its stock movement once F05 is implemented; reversals preserve the original movement history.

#### F07 — Product bundles

- Test bundle start/end times, inactive bundles, insufficient component stock, quantity limits, and proportional discount allocation.
- Test bundles containing differently taxed and differently eligible components.
- Pass condition: components retain their own tax/discount result and inventory is deducted only from component SKUs.

#### F08 — Cashier shifts and cash turnover

- Test opening float, cash sale, QR sale, cash in/out, cash refund, expected cash, denomination count, variance, and threshold approval.
- Test duplicate open-shift prevention, wrong-cashier close, closed-shift immutability, and adjustment records.
- Pass condition: QR never enters expected physical cash and the turnover report reproduces the approved formula exactly.

#### F09 — Voids, returns, and corrections

- Integration-test void-before-settlement, full return, partial return, damaged return, replacement sale, and unauthorized attempts.
- Verify original financial, tax, inventory, and audit records remain immutable and linked reversal movements net correctly.
- Pass condition: no correction deletes or edits a finalized record, and every reversal identifies requester, approver, reason, and original transaction.

#### F10 — Reports, exports, and audit reports

- Reconcile daily/monthly report totals against seeded line-level sales for VATable, VAT-exempt, zero-rated, SC, PWD, discounts, returns, cost, margin, and settlement method.
- Test Asia/Manila day/month boundaries, UTC storage, empty periods, large datasets, and historical rule versions.
- Test UTF-8 CSV, commas, quotes, newlines, Unicode, stable columns, and spreadsheet-formula injection protection.
- Pass condition: report and export totals match the source ledger and calculation snapshots to the centavo.

#### F11 — Backup, restore, and recovery

- Test encrypted backup creation through the system file picker, manifest/checksum validation, wrong passphrase, corrupted/truncated file, incompatible version, and insufficient storage.
- Perform a round-trip test: seed data, back up, remove the test database, restore, and compare record counts, totals, audit history, lots, and settings.
- Verify a safety backup is made before restore and raw databases are never exported.
- Pass condition: a verified backup restores an equivalent database and invalid packages cannot modify live data.

#### F12 — Isolated Test Mode

- Test separate database files, distinct transaction-ID prefixes, mode switching authorization, and visible Test Mode labels.
- Attempt sales, inventory changes, shifts, exports, and backups in Test Mode, then prove live counts and sequences are unchanged.
- Pass condition: no Test Mode action can mutate or appear in live data or reports.

#### F13 — Secure local iPad dashboard

- Test HTTPS pairing, single-use/expired tokens, login, role-scoped endpoints, logout, session revocation, throttling, and read-only enforcement.
- Test multiple browser tabs/clients, malformed requests, direct API calls, service stop, Wi-Fi change, screen lock, sleep, reboot, and certificate trust on the actual iPad.
- Verify the service binds only to the intended private interface and is not reachable from an untrusted/public network.
- Pass condition: authorized users can view and request allowed exports/backups, while all unauthorized writes and sessions are rejected.

### 20.2 Release-level acceptance criteria

Medtryx is ready for pilot use only when:

- mixed carts preserve line-level tax and discount treatment;
- all required calculations reproduce approved examples to the centavo;
- SC/PWD treatment applies only to explicitly selected eligible lines;
- product edits do not alter historical sales;
- finalization cannot create a sale without its matching inventory movements or vice versa;
- voids and returns are linked, authorized reversals rather than deletions;
- cashier cash turnover separates cash from QR declarations;
- all critical admin and financial actions appear in the audit log;
- the iPad dashboard requires secure pairing and role authorization;
- encrypted backup and tested restore succeed;
- Test Mode is isolated from live data;
- the exact HUAWEI device passes the compatibility gate;
- every finalized live sale has a unique, automatically generated Medtryx transaction ID;
- the internal transaction summary is clearly marked as not being an invoice;
- an authorized owner, administrator, pharmacist, or supervisor approves the configured VAT, SC/PWD, BNPC, and rounding rules, with external professional review still recommended; and
- internal summaries cannot reasonably be mistaken for official invoices.

---

## 21. Delivery Plan

The delivery sequence, dependency map, current repository position, work-package acceptance gates, and rollout checklist are maintained in the [Medtryx MVP Delivery Roadmap](MVP_Implementation_Priorities.md). Use that roadmap together with the feature requirements and tests in Sections 20.1 and 20.2.

| Phase | Outcome | Feature coverage | Completion gate |
| --- | --- | --- | --- |
| 0. Device and policy gate | Prove platform feasibility on BTKR-W09 and record required setup decisions | Platform foundation for F01–F13 | Physical-device checks pass, or an approved replacement decision is recorded |
| 1. Offline operational core | Secure offline catalog, stock, calculations, checkout, and cashier shifts | F01–F06, F08 | Feature tests, migration/rollback checks, reconciliation, and MatePad smoke test pass |
| 2. Controls and recovery | Bundles, corrections, reporting, backups, and isolated practice | F07, F09–F12 | Reversal/report reconciliation, restore, Test Mode isolation, and Phase 1 regression pass |
| 3. Local iPad dashboard | Secure role-scoped local access to reports and permitted requests | F13 and remote F10/F11 actions | Actual MatePad/iPad security and lifecycle checks pass |
| 4. Pilot and production rollout | Prepare staff, data, procedures, release, and recovery | F01–F13 | Release acceptance passes and owner authorizes go-live |

A phase is not complete when coding stops. Its feature acceptance tests, applicable device checks, and exit gate must pass. The roadmap records the current state separately from future release criteria; the presence of a scaffold or test notes does not by itself establish phase completion.

---

## 22. Confirmed MVP Decisions and Remaining Questions

### 22.1 Confirmed MVP decisions

- **Tax status:** The pharmacy is VAT-registered.
- **Store scope:** One store for the MVP.
- **Device:** HUAWEI MatePad 11.5, model BTKR-W09, with 8 GB RAM, 256 GB total storage, and HarmonyOS 4.2.0.
- **Price basis:** Selling prices are VAT-inclusive.
- **Official invoice:** Manual and handled outside Medtryx. The cashier does not enter its number in the app.
- **Internal reference:** Medtryx generates its own transaction ID automatically.
- **Inventory unit:** Every product is listed individually and has its own SKU-specific unit. Pack conversion is optional per product rather than one global rule.
- **Lot and expiry:** Included in the MVP for medicine stock.
- **Starting catalog:** Support both manual product/opening-stock entry and protected CSV import.
- **SC/PWD proof in Medtryx:** The cashier checks the physical ID; the app records customer name, ID type, ID number, and confirmation that it was checked. It stores no ID photo.
- **BNPC 5%:** Included behind an administrator-only feature switch and off by default until its policy data is configured.
- **Protected changes:** Cashiers cannot change prices, tax classes, discount eligibility, inventory adjustments, or finalized sales. Owner, administrator, pharmacist, and supervisor roles may receive the necessary permissions.
- **Initial SKU approval:** An owner, administrator, pharmacist, or supervisor may approve the starting tax class and benefit eligibility for a product. Every approval remains audited.
- **Rounding approval:** Any authorized non-cashier role—owner, administrator, pharmacist, or supervisor—may approve the system-wide rounding configuration during setup. Cashiers cannot change it.
- **SC/PWD operating procedure:** Only the physical ID is checked for the MVP. Prescription and purchase-booklet capture are not part of the app.
- **System status:** Medtryx is intended as an internal operational tool and does not generate or replace the official invoice.
- **Backup destination:** Encrypted backup packages are saved to a folder accessible through the tablet's file manager.
- **Payment:** Medtryx records a declared method such as cash or QR but does not process or verify payment.
- **Negative stock:** Blocked by default.
- **Bundles:** Virtual by default, so stock and tax stay at component level.
- **iPad dashboard:** Read-only except for authorized export and backup requests by default.

### 22.2 Remaining questions required before implementation is complete

1. **BNPC configuration:** What current covered-product list, purchase cap, booklet process, and effective date should be loaded before the admin enables it? Until answered, BNPC remains off.
2. **Other discounts:** Which discounts besides SC, PWD, and BNPC are needed for the MVP?
3. **Returns:** Are medicine/product returns allowed, within how many days, and which roles may approve them?
4. **Price overrides:** Should authorized staff be able to override a price for one sale, or must they update the product master first?
5. **Shift variance:** What cash variance amount requires supervisor approval?
6. **QR methods:** Which QR providers/names should appear, and is an optional reference number needed?
7. **Barcode input:** Will checkout use manual search, the tablet camera, a Bluetooth/USB scanner, or all three?
8. **Outage recovery:** Which non-cashier role may back-enter a sale after the tablet was unavailable?
9. **Local network:** Will the tablet and iPad use a pharmacy-controlled Wi-Fi router, and can a local trust certificate be installed on the iPad?
10. **Server availability:** Should the iPad dashboard work only while Medtryx is visibly hosting, or whenever the tablet is powered on?
11. **Backup schedule:** How often should the encrypted local backup run, how long should files be retained, and who holds the recovery passphrase?
12. **Second copy:** Where will staff copy backups periodically so device loss or failure does not destroy both the live data and its only backup?

---

## 23. Research Basis

The design above is based primarily on the following official or government-hosted sources:

- [Republic Act No. 9994 — Expanded Senior Citizens Act](https://lawphil.net/statutes/repacts/ra2010/ra_9994_2010.html)
- [BIR Revenue Regulations No. 7-2010 — Senior Citizen tax privileges](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/10/55830)
- [BIR Revenue Regulations No. 11-2015 — SC sales record requirements](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2011-2015.pdf)
- [BIR Revenue Regulations No. 5-2017 — PWD discount and VAT computation](https://ncda.gov.ph/disability-laws/implementing-rules-and-regulations-irr/revenue-regulations-no-5-2017-rules-and-regulations-implementing-republic-act-no-10754/)
- [BIR RMC No. 71-2022 / Joint Memorandum Circular 01-2022](https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%2071-2022.pdf)
- [Republic Act No. 11534 — VAT-exempt medicine categories](https://lawphil.net/statutes/repacts/ra2021/ra_11534_2021.html)
- [BIR RMC No. 59-2025 — medicine-list update](https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2059-2025.pdf)
- [Republic Act No. 11976 — Ease of Paying Taxes Act](https://lawphil.net/statutes/repacts/ra2024/ra_11976_2024.html)
- [BIR Revenue Regulations No. 7-2024 — invoicing requirements](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%207-2024%20%28final%29.pdf)
- [BIR Revenue Regulations No. 11-2025 — electronic invoices](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2011-2025.pdf)
- [BIR Revenue Regulations No. 26-2025 — electronic invoice transition](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2026-2025.pdf)
- [BIR RMO No. 24-2023 — POS/sales software accreditation](https://bir-cdn.bir.gov.ph/local/pdf/RMO%20No.%2024-2023%20Digest%20FINAL.pdf)
- [Republic Act No. 10173 — Data Privacy Act](https://privacy.gov.ph/data-privacy-act/)
- [HUAWEI MatePad 11.5 Philippine specifications](https://consumer.huawei.com/ph/tablets/matepad-11-5-2025/specs/)
- [Android Room documentation](https://developer.android.com/training/data-storage/room)
- [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config)

Laws, tax issuances, covered-product lists, and BIR system requirements can change. Store policy versions and effective dates in Medtryx, and repeat the compliance review immediately before production registration and go-live.
