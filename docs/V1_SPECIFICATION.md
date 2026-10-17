# Medtryx v1 product and feature specification

This is the current product reference for Medtryx v1. It describes implemented behavior, not a roadmap or a promise of legal, accounting, or deployment certification. The [README](../README.md) covers local setup; the [deployment and recovery runbook](DEPLOYMENT_AND_RECOVERY.md) covers a VPS installation.

## Product and operating model

Medtryx is a single-store sales and inventory application for small shops. The application supports two roles: **owner** and **cashier**. The first owner account is created through the command-line bootstrap. Owners manage staff accounts and store settings; cashiers use the sales and drawer workflows permitted by their account. There is one store-wide open cash register shift at a time, so another cashier cannot open a second simultaneous shift.

Medtryx records internal transaction IDs and operational reports. It does not provide statutory invoice registration, tax filing, payment processing, QR payment verification, or accounting certification. Cash and QR payment types are staff-declared records.

Business dates, shift boundaries, schedules, reports, and backup scheduling use `Asia/Manila`, including when the installation currency is USD.

## Currency and tax configuration

A database has one immutable currency. A new database defaults to PHP. A new, empty database may select USD by setting `MEDTRYX_CURRENCY=USD` before it is first opened. Existing financial data stays in its recorded currency; changing the environment variable does not convert amounts, and a currency mismatch must be resolved as an installation/configuration issue rather than treated as conversion.

The web application reads the public `/api/config` before rendering money. It uses the installation currency for currency labels, amounts, and exports. If configuration cannot be loaded or validated, the app asks the user to retry and does not display money using an assumed currency.

Regular-sale tax settings are owner-controlled and require appropriate accounting review. The application does not determine a shop's legal obligations or provide universal tax compliance. In USD mode, the unapproved regular-tax default is a provisional 0%; this is a neutral starting configuration, not US tax guidance. PHP-specific Senior Citizen, PWD, and BNPC controls and treatments are available only in PHP mode and are rejected by server-side USD checks. Their availability does not certify legal eligibility or compliance. Optional cash rounding is a configurable store policy and does not change QR totals or saved line tax.

## Products and inventory

Owners manage an active catalog with product details, selling price, tax class, unit, reorder level, and optional lot tracking. Catalog CSV workflows support opening-stock imports, updates, and exports. Owners can create, edit, activate, and deactivate products. A product can be soft-deleted only if it has never appeared in a sale, even if that sale was later refunded. Soft-deleting a mistaken unsold product preserves its stock-event history and removes any remaining inventory through an audited correction. Products with sale history cannot be deleted; inventory is removed through a recorded stock correction or write-off so prior records remain available.

Stock workflows include opening balances, supplier receipts, count corrections, write-offs, and lot movements. Cost uses weighted-average inventory values and saved cost allocations. Lot-tracked inventory records lot codes and expiry dates; expired or quarantined lots are not saleable. Bundle offers preserve approved offer versions and component quantities, and a sale deducts the corresponding component stock.

When enabled by the owner, checkout stock-count override lets a cashier confirm a physical count and provide a reason when the recorded saleable stock is too low. Lot-tracked products require eligible-lot counts. The sale and positive inventory correction are stored together with the cost basis and count evidence. Owners can filter, review, and export the override history. The override is a controlled reconciliation workflow, not a general stock bypass.

## Sales, shifts, expenses, and corrections

Cashiers build a cart from active products. The server calculates saved sale lines and totals. A sale records cash or QR as declared by staff. One open shift tracks opening float, sales, cash-in/out, refunds, and expected cash. Expenses or refunds may reduce expected drawer cash below zero; the record remains visible for reconciliation.

Owners can review recent sales and paginated history by business date, with a page size of up to 500 records. The quick-action recent list is limited to the most recent 50 sales in its allowed time window. Owners can also review reports and shift history. Full and partial refunds record reason and refund method, and each refunded line records whether stock was restored or written off. A cash refund reduces expected cash in the selected eligible shift. Refunds may be posted against the current shift or original shift where allowed; a closed original shift requires owner approval and the resulting variance is recalculated. A payment correction may be made by an owner or the cashier who recorded the sale during the one-hour quick-action window. It switches the declaration from cash to QR or QR to cash, allows one switch per sale, requires a reason, is recorded in the audit history, and can update closed-shift variance for owner review.

Owners and cashiers can record the supported expense categories: Lunch, Delivery, Other, and supplier Stock Purchase / COD. The workflow distinguishes product invoice amount from delivery fee and records whether a separate delivery fee was included in unit cost. COD product payments are excluded from operating expenses so inventory cost is not deducted a second time; inventory cost affects estimated profit through saved cost of goods sold as items sell. Delivery fees marked included in unit cost are also excluded from operating expenses. Cashier-paid expenses and supplier payments create a drawer cash-out movement; owner-paid payments do not change drawer cash. A supplier payment alone does not receive stock or update product cost.

## Reports, audit history, and journal

Reports use inclusive Manila business-date ranges and can be exported to CSV. They include sales, payments, refunds, cash movements, expenses, stock purchases, inventory balances, write-offs, lot alerts, and estimated profit measures. Inventory value and low-stock figures describe current balances, not historical end-of-day stock. Profit figures are estimates based on recorded costs, adjustments, and expenses; unrecorded costs are not included. CSV exports are formula-safe and identify the currency.

Owners can search and filter the activity history by supported fields and action types. Views of protected customer benefit records are themselves audit logged. The daily sales journal creates editable monthly copies of source sales totals for a selected range of up to 12 months. Editing a journal copy does not rewrite canonical sale records and is audit logged.

## Optional receipt OCR

Owners may submit supplier receipt images or PDFs to the configured external OCR provider for suggested line-item extraction, packaging conversions, and possible catalog matches. The owner reviews and edits suggestions before importing stock. OCR output is not authoritative and uncertain package conversions must not be accepted without review. This workflow sends receipt contents to the external provider; its handling and retention depend on that provider and the configured account.

## Access, data, backups, and deployment

There is no public account-registration route. Passwords are hashed with Argon2id; authenticated writes use session and CSRF protections with role checks. Senior Citizen/PWD customer identity fields are encrypted at rest with AES-256-GCM when the required key is configured. This does not mean that the entire database is encrypted.

Application backup packages contain the database and a copy of the customer-ID encryption key needed for restoration. The archive itself is not encrypted. Treat backup packages as sensitive, restrict access, and protect both configured backup locations. Recovery should be rehearsed using the runbook before relying on backups. Automatic live backups require completed store setup and configured backup destinations.

The repository includes a VPS deployment workflow and configuration examples, but the actual host, domain, certificates, access policy, storage media, service setup, and recovery rehearsal remain operator work. Follow the deployment runbook and validate the installation on its real environment before entering live business data.

## Current limits

- One store and one currency per database; no currency conversion or multi-currency sales.
- Business date and schedule behavior remains tied to Manila time.
- PHP-specific statutory benefit treatment is unavailable in USD; USD mode does not implement US tax rules.
- No statutory invoice/e-invoice service, payment processor, QR verification, or multi-register/branch model.
- OCR depends on an external provider and owner review.
- Inventory, profitability, and reports depend on the completeness and accuracy of user-entered records; estimates are not accounting or legal advice.
