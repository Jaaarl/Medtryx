# Medtryx implementation status

Source of truth: `Medtryx_Simplified_Web_Product_and_Technical_Specification.md` and `Medtryx_Web_Tech_Stack_and_Roadmap.md`.

The repository baseline already exists as commit `1e05374` (`Initial Docs`), containing the current Markdown documents. No live data or customer data is used.

## Ordered feature bundles

1. **Foundation and accounts** — Workspaces, React/Vite/Tailwind/browser routing, Express/Zod API, SQLite migrations, isolated development/test/live databases, login/logout, owner/cashier sessions and authorization, audit events, and owner-managed staff accounts. Dependencies: none. Acceptance: clean migrations; direct browser routes work after refresh; secure session and CSRF checks; owner-only user management enforced by API; cashier cannot invoke protected write routes; tests use synthetic, isolated data. Status: complete.
2. **Owner catalog and stock** — Owner-only product maintenance, opening stock, receipts with per-receipt unit cost, adjustments/write-offs, weighted-average inventory value, history, low-stock and owner cost views; cashier catalog search. Dependencies: foundation/accounts. Acceptance: role boundaries verified through UI and direct API; quantity/value reconcile to immutable stock events; selling price is independent of receipt cost. Status: queued.
3. **Checkout and tax calculations** — Cart, configurable approved line-level VAT/SC/PWD rules, cash/QR declaration, snapshots, unique internal transaction IDs, idempotency, atomic stock/sale/COGS finalization. Dependencies: catalog/stock and documented owner/professional tax and rounding approval before live use. Acceptance: approved centavo examples; mixed eligible/ineligible lines; immutable snapshots; rollback, duplicate submit, and simultaneous last-unit tests. Status: queued.
4. **Reversals and shifts** — Owner reauthentication and reasoned full-sale reversals, stock/cost restoration choice, opening cash, close/count/variance. Dependencies: checkout. Acceptance: immutable linked original; reversal and stock values reconcile; QR excluded from physical cash; non-zero variance policy applied. Status: queued.
5. **Reports, backups, and hardening** — Manila-day reports and safe CSV, access-restricted unencrypted backup plus separate second copy, verified clean restore, deployment and recovery guide, local HTTPS and browser workflows. Dependencies: inventory, checkout, reversals/shifts; backup destination and host/network decisions for deployment. Acceptance: report reconciliation, restored totals and protected records, backup access controls, browser tests. Status: queued.
6. **Pilot and release gates** — Load only owner-approved synthetic/pilot catalog as appropriate, document staff procedures, parallel manual checks, failure/recovery rehearsal, actual device/network tests and release checklist. Dependencies: all prior bundles and owner/professional decisions. Acceptance: every applicable roadmap and product acceptance criterion passes; external approvals and physical-device checks are explicitly evidenced. Status: queued.

## Decisions and constraints

- The proposed local single-server architecture, single fixed stock unit per SKU, manual expiry workflow, cash/QR declared payments, and owner-approved full reversals are reversible implementation defaults from the source documents.
- Foundation account defaults: Argon2id hashes, 12-character minimum passwords, 30-minute idle and 12-hour absolute session expiry, strict same-site secure cookies, self-deactivation blocked, and first owner provisioned by a one-time CLI. These are documented and reversible before live use.
- Tax classes/rate, statutory benefit treatment details and rounding examples, supplier-cost basis, invoicing/registration and privacy approvals remain owner/professional decisions before live use. No sale-calculation defaults will be represented as approved policy.
- Store OS, local address/network, planned client browsers/devices, backup destination, and physical certificate trust require confirmation/testing before the release gates that depend on them.
- Node.js 24 LTS is the roadmap target. The available workspace runtime is Node.js 22.17.0; this environment limitation will be recorded and checked again before release validation.

## Progress log

- Baseline inspected: existing clean Git baseline `1e05374`; its four Markdown documents are preserved. Added ignore rules before adding application data or dependencies.
- Foundation and accounts complete: migrations, environment database isolation, login/logout/password change, role-guarded staff management, audit history, CSRF protection, and responsive browser routes implemented. API suite: 9 checks passed; Chromium workflows: 2 passed; TypeScript typecheck, ESLint, Prettier check, and production build passed; `npm audit` reported 0 vulnerabilities.
- Local runtime used for checks: Node.js `22.17.0`; project engine and planned deployment target are Node.js 24 LTS. Re-run the full check set on Node 24 before release. Browser e2e used installed Chromium at desktop viewport; the store's physical devices, local HTTPS, and network remain untested.
- Next: owner catalog and simple stock, including receipt-level costs and moving weighted-average valuation.
