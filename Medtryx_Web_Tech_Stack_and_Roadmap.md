# Medtryx Web — Tech Stack and Implementation Roadmap

**Status:** Proposed build plan, September 27, 2026  
**Product scope:** [Medtryx Simplified Web Product and Technical Specification](Medtryx_Simplified_Web_Product_and_Technical_Specification.md)  
**Deployment assumption:** One pharmacy, one store computer/server, browsers on a private local network

The owner has brought exactly three follow-on features into the current web scope, in order: lot/expiry management, virtual sales bundles, and a separately controlled BNPC benefit. Preserve the existing React/TypeScript, Express, SQLite, one-store architecture. Android/Room, cloud hosting, multi-branch operation, and offline browser sales remain out of scope.

## 1. Technical approach

Build one responsive browser interface and one server application. The server owns authentication, price and discount calculations, stock changes, reports, and the database. Browsers never write directly to the database or decide the final amount of a sale.

```text
Staff browser (desktop / laptop / tablet)
        |
        | HTTPS on private store network
        v
      Caddy
        |
        v
Node.js + Express server
  ├─ serves built React app
  ├─ API and business rules
  ├─ SQLite database on the server's local disk
  └─ access-restricted backups to separate storage
```

Internet access is not needed for a normal sale while the store server and local network are working. A browser offline mode is not part of the MVP.

## 2. Chosen stack

| Layer | Choice | Why it fits this MVP |
| --- | --- | --- |
| Language | **TypeScript** for browser and server | One language and shared data types reduce handoff mistakes. |
| Browser UI | **React + TypeScript + Vite** | Supports a responsive checkout, product forms, and reports without a mobile app. Vite has an official React/TypeScript template. [Vite guide](https://vite.dev/guide/), [React TypeScript guide](https://react.dev/learn/typescript) |
| Styling | **Tailwind CSS** with its Vite plugin | Use responsive utility classes and a small set of reusable checkout components. [Tailwind Vite setup](https://tailwindcss.com/docs/installation/using-vite) |
| Page routing | **React Router** in browser/declarative mode | Provide routes such as `/checkout`, `/products`, `/stock`, `/sales`, and `/reports`, with a shared layout and signed-in screen guards. Current React Router uses `react-router` for `BrowserRouter`; `react-router-dom` was removed in v8. [React Router setup](https://reactrouter.com/start/declarative/installation), [v8 change](https://reactrouter.com/changelog) |
| API/server | **Node.js 24 LTS + Express 5** | One server process can serve the built UI and JSON API. Node 24 is an LTS line as of this plan; Express 5 supports this Node version. [Node releases](https://nodejs.org/en/about/previous-releases), [Express 5 guide](https://expressjs.com/en/guide/migrating-5/) |
| Database | **SQLite** on the server's local disk | Appropriate for one store and one server; use transactions, foreign keys, and WAL mode. WAL permits readers while a writer works, but SQLite still has one writer at a time. [SQLite WAL](https://www.sqlite.org/wal.html) |
| Database access | **better-sqlite3** with parameterized SQL and numbered SQL migrations | Direct SQL is enough for this small data model and supports transactions and an online backup method. [Project documentation](https://github.com/WiseLibs/better-sqlite3) |
| Exact money calculations | **decimal.js** on the server; persist amounts as integer centavos | Avoid binary floating-point rounding in tax, discount, acquisition-cost, and gross-profit results. Record the approved rounding rule and each sale-line result. [decimal.js](https://github.com/MikeMcl/decimal.js/) |
| Request validation | **Zod** schemas in Express middleware for every write endpoint | Reject malformed products, quantities, discounts, and stock changes before business logic runs. [Zod basics](https://zod.dev/basics) |
| HTTPS entry point | **Caddy** reverse proxy with a local certificate authority | Gives browsers HTTPS on the private network. Its root certificate must be trusted on each managed client device. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy service guidance](https://caddyserver.com/docs/running) |
| Unit/integration tests | **Vitest** | Test tax calculations, permissions, stock updates, and API/database transactions. [Vitest guide](https://vitest.dev/guide/learn/writing-tests) |
| Browser tests | **Playwright** | Test the actual checkout and owner workflows in desktop and tablet-sized browsers. [Playwright browsers](https://playwright.dev/docs/browsers) |
| Package management | **npm workspaces** and a committed lockfile | Keep the web app, server, and shared types in one repository with repeatable installs. |

Pin actual dependency versions in the lockfile when development starts. Apply security and maintenance updates deliberately, with a test run and database-backup check before deploying them.

React Router handles **browser page navigation**; Express handles `/api/*` requests. In development, Vite proxies `/api` to Express. In production, Express serves the built React files and returns the app's `index.html` for browser routes such as `/products/123`, while unknown `/api/*` paths stay API errors. Page guards improve navigation, but Express still checks authorization for every request.

### Why SQLite is acceptable here

All clients talk to **one** server; only that server opens the database file. SQLite is not placed on a shared network drive. A sale, stock deduction, stock-history entry, and internal transaction ID are committed in one database transaction. Test two simultaneous attempts to sell the final unit. If the shop later needs many stores, many server instances, or high write volume, plan a database migration rather than sharing the SQLite file. SQLite documents the local-host limitation and single-writer behavior of WAL mode in its [WAL guide](https://www.sqlite.org/wal.html).

## 3. Suggested repository layout

```text
medtryx/
  apps/
    web/                 React routes, Tailwind UI, browser API client
    server/              Express API routes, auth, business rules
  packages/
    shared/              API types, allowed enum values
  database/
    migrations/          Numbered SQL migrations
  tests/
    e2e/                 Playwright browser workflows
  docs/                   Store setup and recovery instructions
```

The server is the source of truth. Shared types help the UI display data, but they do not replace server validation and authorization.

## 4. Data and business-rule design

### Core tables

`users`, `sessions`, `products`, `stock_events`, `inventory_lots`, `lot_stock_movements`, `lot_reconciliations`, `sale_line_lot_allocations`, `sales`, `sale_lines`, `sale_reversals`, `shifts`, `cash_movements`, `audit_events`, and `settings`, plus virtual bundle and versioned benefit-policy records. Store product-level lot tracking, current SKU quantity/value, selling price, generic/branded type, and independent statutory eligibility flags. Existing stock without trustworthy lot identity remains unallocated until audited physical reconciliation. Use database constraints for unique SKU, unique optional barcode, unique internal IDs, non-negative balances/value, append-only events, and at most one open shift.

Each `sale_line` snapshots product name, SKU, unit, generic/branded type, quantity, selling price, tax class, independent statutory eligibility, selected treatment, policy/rule version, tax, promotional and statutory discounts, amount due, allocated acquisition cost/COGS, and exact lot allocation. Bundle-expanded lines also retain bundle identity/version, regular prices, and allocation rule. The parent `sale` snapshots declared payment, cash rounding, BNPC weekly allowance/policy and protected holder type, and final due. A full reversal snapshots the saved amount and lot action. Reports read saved values; later product, offer, or policy edits never recalculate old sales.

### Inventory cost and profit

Keep **one selling price per SKU** and a separate **unit acquisition cost on each opening-stock entry or receipt**. Require a cost for live stock; a genuine zero-cost entry needs a reason. Calculate the current weighted-average unit cost from inventory value divided by quantity. A later receipt with a new cost changes the average cost but does not change the selling price. Show latest receipt cost, average cost, current selling price, estimated unit price spread, and estimated unit gross profit on the owner inventory screen. The spread is `selling price − average unit cost`; the gross-profit estimate is normal-sale revenue excluding output VAT minus average unit cost. Receipt history shows each acquisition price and its spread against the current selling price. Cashiers see price and stock availability without cost or profit.

At sale finalization, allocate COGS from the inventory value on hand, save it on the sale line, and reduce inventory value in the same transaction as quantity. Keep any centavo residual in the remaining inventory value; zero it when stock reaches zero. A sellable reversal restores the original sale's allocated cost. A damaged/expired adjustment records a separate stock write-off. Management gross profit uses saved sale revenue after discounts and excluding output VAT, minus saved COGS. The owner/accountant must approve the acquisition-cost basis, including supplier VAT treatment. Weighted average is one inventory cost formula described in [IAS 2](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ias-2-inventories.pdf?bypass=on).

### Sale finalization

1. Check the signed-in cashier and open shift.
2. Validate cart, benefit selection, and declared settlement method on the server.
3. Re-read current product settings, bundle rules/prices/dates/limits, policy versions, weekly BNPC ledger, stock, and lot availability inside a database transaction.
4. Expand bundles into their component product lines. Calculate each component's own tax and statutory treatment; allocate bundle promotional cents deterministically by regular component price and do not stack BNPC with that promotion.
5. Allocate tracked stock by FEFO on the Asia/Manila calendar date, exclude expired/quarantined/unallocated stock, and require the cashier's confirmation of the physical pick.
6. Calculate lines using approved decimal and tax-component rounding. BNPC preserves the normal tax class and is subject to the versioned weekly cap/evidence rules; the feature remains off until approved. Cash rounding affects only the combined CASH total.
7. Deduct SKU and lot stock and write all immutable allocation, cost, benefit, promotion, audit, and stock snapshots in the sale transaction.
8. Return the saved result. A repeated submit with the same request key returns the same sale instead of creating a duplicate.

The last-unit and repeated-submit cases need integration tests. The browser shows the server's saved total and labels any summary **INTERNAL SALES RECORD — NOT AN INVOICE**.

### Security and personal data

- Use individual staff accounts and server-side role checks on every protected API route. Only the owner may create, edit, deactivate, or import inventory products and change stock, prices, or classifications; cashiers may select existing active products for checkout. Cost and profit reads are owner-only.
- Hash passwords with **Argon2id** using a maintained server library; never store plaintext passwords.
- Use opaque, server-backed sessions in `HttpOnly`, `Secure`, `SameSite` cookies; expire idle sessions and revoke them at logout. Protect state-changing requests against CSRF. [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- Keep the server reachable only on the pharmacy's private network, with the host firewall allowing approved clients. Do not expose the Express port to the internet.
- Encrypt stored SC/PWD names and ID numbers using a server-side key kept outside the database; restrict who can see full details. Do not log those values or put them in general CSV exports.
- Record actor, time, old/new values, and reason for protected product, stock, void, and settings actions.
- Back up both the database and the field-encryption key in an **unencrypted**, access-restricted recovery package, then verify a restore on another test machine. Keep the package away from public downloads and shared network folders.

The privacy controls support the [Philippine Data Privacy Act](https://privacy.gov.ph/data-privacy-act/). The pharmacy still needs its own access, retention, and incident procedures.

### Backup and deployment

Run the server and Caddy as services that start with the store computer. Give the server a fixed local address or stable local hostname. Install and trust Caddy's local root certificate on the planned cashier and owner devices; test the actual browsers before pilot. Keep the database on the server's **local disk** and configure automatic daily **unencrypted** backups in a folder limited to authorized staff, plus a second copy on separate trusted storage controlled by the owner.

Use SQLite's online backup method through the database library; copying only the live `.db` file can miss changes while WAL mode is in use. [SQLite backup API](https://www.sqlite.org/backup.html), [better-sqlite3 backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

Maintain separate **development**, **test**, and **live** databases. Test transactions carry visible test labels and never appear in live reports. Run schema migrations against a backed-up copy before every live upgrade. Document the update and rollback steps for the chosen Windows or Linux host.

## 5. Roadmap

The estimates below are planning ranges for **one experienced full-time developer**. They exclude catalog data entry, external tax/legal decisions, hardware purchasing, and delays obtaining production approvals. Work can be demonstrated at the end of each phase; a phase is complete only when its exit gate passes.

| Phase | Approximate effort | Build and decisions | Exit gate |
| --- | --- | --- | --- |
| **0. Confirm workflow and server** | 1 week | Confirm store computer/OS, number of concurrent cashiers, browser devices, local network, stock unit convention, acquisition-cost basis, tax/discount review owners, and lot reconciliation procedure. Test local HTTPS on the actual devices. | Browser reaches a secure test page on the planned network; product, cost, stock, and approval processes are assigned. |
| **1. Foundation and accounts** | 1–2 weeks | Create workspaces, Vite/React/Tailwind setup, React Router layout and pages, Express API and Zod validation, build pipeline, migrations, database schema, login/logout, sessions, cashier/owner permissions, audit logging, test database. | Browser routes load directly and after refresh; cashier product-create API requests fail; migrations run from a clean install; test and live data are separate. |
| **2. Products and simple stock** | 2–3 weeks | Build owner-only product entry/search/edit, opening stock and receipts with unit acquisition cost, weighted-average inventory value, adjustments and write-offs, stock/cost history, low-stock view, and inventory profit estimate; optionally simple CSV import after manual entry works. | Only the owner can create products or change stock; cashiers can find existing products for checkout; stock quantity and value reconcile with events. |
| **3. Checkout and calculations** | 2–3 weeks | Build cart, regular/SC/PWD line calculations, cash/QR declaration, optional approved nearest-₱0.25 cash-total rounding, unique internal IDs, atomic finalization with COGS and rounding snapshots, duplicate-submit protection, and transaction view. | Approved centavo, cash-rounding boundaries, and COGS examples pass; QR stays exact; mixed carts treat only selected eligible lines; last-unit concurrency and rollback tests pass. |
| **4. Voids and shifts** | 1–2 weeks | Add owner-approved full reversals, stock-and-cost restoration choice, the single store-wide register, opening cash, shift close, cash count, variance, and owner shift history. | Originals remain immutable; reversal totals, stock quantity, and stock value are correct; QR is excluded from physical cash; only one shift can be open across accounts; owners can reconcile who opened/closed each shift and its cash. |
| **5. Reports, backups, and hardening** | 2–3 weeks | Add Manila date-range sales, COGS, estimated gross-profit, cash-rounding-adjustment, stock-value, and write-off reports with daily and month-to-date selections; safe CSV export, access-restricted backup/restore, local HTTPS setup, deployment scripts, recovery guide, and browser tests. | Inclusive ranges and CSV reconcile to saved lines, separate cash-rounding adjustments, reversals, and cash events across date boundaries; current stock is labeled as a current balance; restore reproduces totals, stock, inventory value, and authorized customer data; actual planned devices pass checkout and owner tasks. |
| **6. Lot, batch, and expiry** | Follow-on bundle | Add additive migration preserving existing stock/value/events as unallocated, owner-controlled tracking, tracked receipts/adjustments, physical reconciliation, FEFO allocation/pick confirmation, expiry alerts/quarantine/disposal, original-lot reversal, reports, backup validation, and upgrade-copy rehearsal. | Legacy stock is not assigned invented lots; saleable balances, concurrent last-unit sales, expiry boundary, reconciliation, reversal, reports, and restore reconcile in tests. |
| **7. Virtual bundles** | Follow-on bundle | Add owner-managed dated offers, explicit promotional price approval, component mapping, price reduction suggestions, limits, cart expansion, deterministic centavo allocations, statutory interaction display, component stock/tax/benefit/lot snapshots, reporting, and reversal coverage. | Offer date/limit/tamper checks pass; repeated bundle components and mixed tax/benefit lines preserve each SKU; promotional discounts sum to approved price. |
| **8. BNPC benefit** | Follow-on bundle | Add explicit product category/source/review metadata, separate line treatment, versioned policy switch off by default, protected identity/booklet workflow, Asia/Manila weekly usage, prior-purchase allowance, cap/four-kind evidence, more-favorable promotion comparison, reporting, and backup coverage. | Synthetic rules and history tests pass; BNPC never removes VAT or stacks with bundle promotion; live enablement waits for owner/accountant approval of current policy and store/site eligibility. |
| **9. Pilot and release** | 1–2 weeks | Load only approved catalog and physically reconciled opening stock, train staff, run parallel manual checks, test power/network failure and recovery, and fix findings. | Owner accepts site/device workflow, lot handling, bundle pricing, statutory policies, invoice review, backup restore, and every release gate. |

**Planning total:** roughly **10–16 developer weeks**, depending on catalog import, cost-data cleanup, device setup, and how many workflow changes appear during pilot. The phase gates matter more than the calendar estimate.

### Build order and dependencies

```text
Workflow decisions + secure local access
          ↓
Database, users, and permissions
          ↓
Products and stock
          ↓
Tax/discount engine + checkout finalization
          ↓
Voids, shifts, and reports
          ↓
Verified backup/restore + actual-device pilot
```

Tax and discount examples can be developed in parallel with product screens, but checkout must use the approved server calculation before any live sale. Stock deduction and sale saving must never be released as separate steps.

## 6. Release checklist

- [ ] Store server, network, stable address, and HTTPS trust work on every planned browser.
- [ ] Product units, selling prices, acquisition-cost basis, tax classes, SC/PWD eligibility, and starting quantities are approved and checked.
- [ ] Cashiers can add existing products to checkout but cannot create or edit inventory products; owner-only permissions are tested through both the UI and direct API requests.
- [ ] Money calculations match approved examples to the centavo, including mixed carts.
- [ ] Simultaneous last-unit sales and duplicate button submissions do not oversell or duplicate transactions.
- [ ] Different receipt costs produce the expected weighted-average cost without changing selling price or past sales.
- [ ] Tracked and untracked products use separate validated flows. A pre-feature database upgrade copy preserves stock totals, valuation, events, indexes, constraints, and historical snapshots; legacy stock remains unallocated until owner physical reconciliation.
- [ ] FEFO uses the Asia/Manila date with the printed expiry date as the last saleable day; same-expiry tie-breaks are stable; expired, quarantined, unallocated, and simultaneous last-unit cases are covered.
- [ ] Cashiers see assigned FEFO batches and confirm their physical pick; owner lot disposals and reversal/write-off choices name the exact lot and reconcile stock, value, and history.
- [ ] Owner lot balances, expiry alerts, near-expiry horizon, report/CSV data, and backup/restore verification match the lot and stock-event ledgers.
- [ ] Virtual bundles have no physical stock. Owner approves promotional prices and either per-sale or promotion-wide limits; tests cover dates, repeated bundles, component shortage, tampering, deterministic centavo remainders, mixed tax/benefit treatment, and original component reversals.
- [ ] BNPC product flags default ineligible and are independent of tax/SC/PWD settings. Its versioned feature switch is off by default; policy, line snapshots, weekly cap, proof workflow, VAT behavior, promotional comparison, reports, and restore are tested before consideration for enablement.
- [ ] The owner/accountant records current BNPC rule, SKU/category interpretation, source/review metadata, store eligibility, centavo/tax/booklet/four-kind/reversal decisions, weekly external-spend verification, and explicit approval before live enablement.
- [ ] Voids, shift cash, COGS, estimated gross profit, inventory value, and daily reports reconcile with saved sales and stock events.
- [ ] Owner reports accept inclusive Manila start/end dates, month-to-date selection works, and the exported CSV matches the displayed period, including reversals on their event dates.
- [ ] The database prevents concurrent open shifts store-wide; owner shift history shows opening/closing accounts, times, and cash reconciliation, and cashier direct API access is denied.
- [ ] Before applying the single-register migration to an existing database, a verified copy has no more than one open shift. If there are multiple open shifts, stop and reconcile each physical drawer with its cashier before retrying; the migration does not close or alter shifts automatically.
- [ ] An access-restricted unencrypted backup restores on a clean test installation; a second copy is stored separately under the owner's control.
- [ ] Staff know receipt and expiry checks, physical legacy-stock reconciliation, FEFO shelf picking, exact-lot disposal/reversal, booklet and prior-purchase checks if approved, manual invoicing, outage, and recovery procedures.
- [ ] Owner obtains the required review of tax/discount rules, invoicing, privacy, and any system registration before live use.

## 7. Later technical changes

The three requested follow-on bundles are scheduled as phases 6–8 and must complete before pilot/release phase 9. The BNPC switch remains disabled until legal, accounting, store-eligibility, and operational approval is recorded. Pack conversion, physical bundle inventory, supplier purchasing, partial returns, Android/Room, cloud hosting, multiple branches, and browser offline sales require separate scope and architecture decisions.
