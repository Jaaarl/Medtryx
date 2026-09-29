# Medtryx Web — Tech Stack and Implementation Roadmap

**Status:** Proposed build plan, September 27, 2026  
**Product scope:** [Medtryx Simplified Web Product and Technical Specification](Medtryx_Simplified_Web_Product_and_Technical_Specification.md)  
**Deployment assumption:** One pharmacy, one store computer/server, browsers on a private local network

This plan implements the simplified web product. It does not carry forward the original Android app, tablet-hosted server, lot-level inventory, or bundles. If the pharmacy chooses cloud hosting or requires digital lot/expiry tracking before launch, revisit the architecture and schedule first.

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

`users`, `sessions`, `products`, `stock_events`, `sales`, `sale_lines`, `sale_reversals`, `shifts`, `cash_movements`, `audit_events`, and `settings`. Store the current whole-unit stock count, inventory value in centavos, selling price, generic/branded type, and independent SC/PWD eligibility on `products`; record every stock change as a `stock_event`. A receipt event stores its own unit acquisition cost. Use database constraints for unique SKU, unique optional barcode, unique Medtryx Transaction ID, non-negative stock, non-negative inventory value, and at most one open shift per store.

Each `sale_line` snapshots product name, SKU, unit, generic/branded type, quantity, selling price, tax class, separate SC/PWD eligibility, selected benefit, applicable rule/rounding version, tax, discount, amount due, and the allocated acquisition cost/COGS. Reports read these saved values; a later product edit or receipt never recalculates old sales. Product type and benefit eligibility do not determine tax class or professional policy.

### Inventory cost and profit

Keep **one selling price per SKU** and a separate **unit acquisition cost on each opening-stock entry or receipt**. Require a cost for live stock; a genuine zero-cost entry needs a reason. Calculate the current weighted-average unit cost from inventory value divided by quantity. A later receipt with a new cost changes the average cost but does not change the selling price. Show latest receipt cost, average cost, current selling price, estimated unit price spread, and estimated unit gross profit on the owner inventory screen. The spread is `selling price − average unit cost`; the gross-profit estimate is normal-sale revenue excluding output VAT minus average unit cost. Receipt history shows each acquisition price and its spread against the current selling price. Cashiers see price and stock availability without cost or profit.

At sale finalization, allocate COGS from the inventory value on hand, save it on the sale line, and reduce inventory value in the same transaction as quantity. Keep any centavo residual in the remaining inventory value; zero it when stock reaches zero. A sellable reversal restores the original sale's allocated cost. A damaged/expired adjustment records a separate stock write-off. Management gross profit uses saved sale revenue after discounts and excluding output VAT, minus saved COGS. The owner/accountant must approve the acquisition-cost basis, including supplier VAT treatment. Weighted average is one inventory cost formula described in [IAS 2](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ias-2-inventories.pdf?bypass=on).

### Sale finalization

1. Check the signed-in cashier and open shift.
2. Validate cart, benefit selection, and declared settlement method on the server.
3. Re-read current product settings and available quantities inside a database transaction.
4. Calculate each line with the approved decimal and rounding rules.
5. Deduct stock and allocate its inventory cost only when enough units remain; insert sale lines, cost snapshots, stock events, audit event, and unique internal ID in the same transaction.
6. Return the saved result. A repeated submit with the same request key returns the same sale instead of creating a duplicate.

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
| **0. Confirm workflow and server** | 1 week | Confirm store computer/OS, number of concurrent cashiers, browser devices, local network, stock unit convention, acquisition-cost basis, manual expiry procedure, and who approves tax/rounding. Test local HTTPS on the actual devices. | Browser reaches a secure test page on the planned network; product, cost, and stock rules are signed off for development. |
| **1. Foundation and accounts** | 1–2 weeks | Create workspaces, Vite/React/Tailwind setup, React Router layout and pages, Express API and Zod validation, build pipeline, migrations, database schema, login/logout, sessions, cashier/owner permissions, audit logging, test database. | Browser routes load directly and after refresh; cashier product-create API requests fail; migrations run from a clean install; test and live data are separate. |
| **2. Products and simple stock** | 2–3 weeks | Build owner-only product entry/search/edit, opening stock and receipts with unit acquisition cost, weighted-average inventory value, adjustments and write-offs, stock/cost history, low-stock view, and inventory profit estimate; optionally simple CSV import after manual entry works. | Only the owner can create products or change stock; cashiers can find existing products for checkout; stock quantity and value reconcile with events. |
| **3. Checkout and calculations** | 2–3 weeks | Build cart, regular/SC/PWD line calculations, cash/QR declaration, unique internal IDs, atomic finalization with COGS snapshots, duplicate-submit protection, and transaction view. | Approved centavo and COGS examples pass; mixed carts treat only selected eligible lines; last-unit concurrency and rollback tests pass. |
| **4. Voids and shifts** | 1–2 weeks | Add owner-approved full reversals, stock-and-cost restoration choice, the single store-wide register, opening cash, shift close, cash count, variance, and owner shift history. | Originals remain immutable; reversal totals, stock quantity, and stock value are correct; QR is excluded from physical cash; only one shift can be open across accounts; owners can reconcile who opened/closed each shift and its cash. |
| **5. Reports, backups, and hardening** | 2–3 weeks | Add daily sales, COGS, estimated gross-profit, stock-value, and write-off reports; safe CSV export, access-restricted backup/restore, local HTTPS setup, deployment scripts, recovery guide, and browser tests. | Reports reconcile to saved lines and stock events; restore reproduces totals, stock, inventory value, and authorized customer data; actual planned devices pass checkout and owner tasks. |
| **6. Pilot and release** | 1–2 weeks | Load approved catalog/opening stock, train staff, run parallel manual checks, test power/network failure and recovery, fix pilot findings. | Owner accepts real-workflow pilot, manual expiry process, tax/invoice review, backup restore, and go-live checklist. |

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
- [ ] Voids, shift cash, COGS, estimated gross profit, inventory value, and daily reports reconcile with saved sales and stock events.
- [ ] The database prevents concurrent open shifts store-wide; owner shift history shows opening/closing accounts, times, and cash reconciliation, and cashier direct API access is denied.
- [ ] Before applying the single-register migration to an existing database, a verified copy has no more than one open shift. If there are multiple open shifts, stop and reconcile each physical drawer with its cashier before retrying; the migration does not close or alter shifts automatically.
- [ ] An access-restricted unencrypted backup restores on a clean test installation; a second copy is stored separately under the owner's control.
- [ ] Staff know the manual expiry/lot, manual invoice, outage, and recovery procedures.
- [ ] Owner obtains the required review of tax/discount rules, invoicing, privacy, and any system registration before live use.

## 7. Later technical changes

Add lot and expiry tables only when the pharmacy is ready to record a lot at receipt and assign it during sale. That change needs a migration plan for existing stock and new receiving/checkout tests. Cloud hosting, multiple branches, and browser offline sales require separate architecture decisions; they are not assumed by this roadmap.
