# Medtryx web application

Medtryx is being built in roadmap bundles for one pharmacy on one local server. Product scope and release gates are in the [simplified specification](Medtryx_Simplified_Web_Product_and_Technical_Specification.md) and [implementation roadmap](Medtryx_Web_Tech_Stack_and_Roadmap.md). Current progress and decisions are in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Local development

The roadmap target is Node.js 24 LTS. The current development environment may use another Node version; run the app with Node 24 before pilot deployment.

1. Copy `.env.example` to `.env` and use unique local credentials if you need an owner account.
2. Run `npm install` from the repository root.
3. Run `npm run db:migrate` to apply migrations to the selected environment's database.
4. For a fresh development database only, set `MEDTRYX_OWNER_EMAIL` and `MEDTRYX_OWNER_PASSWORD` in `.env`, then run `npm run db:create-owner`. Bootstrap refuses to add an owner once that environment has any users.
5. Run `npm run dev`. Vite is available at `http://127.0.0.1:5173`; Express listens on `http://127.0.0.1:3001` and Vite proxies `/api` requests.

`APP_ENV` selects an isolated SQLite file: `development`, `test`, or `live`. Development and test files default to the ignored `data/` directory; live requires an absolute `MEDTRYX_DATA_DIR` outside the repository. Do not copy development or test databases into live use. The test suite creates synthetic users and isolated test databases. No default staff accounts or real customer data are included.

The local browser development server uses HTTP. App session cookies remain `Secure` by default; browsers permit secure cookies on loopback hosts. `COOKIE_SECURE=false` is reserved for the automated HTTP test server. A Caddy local-HTTPS example is included, but the live host, certificate trust, and client devices are not configured or tested yet.

SC/PWD customer ID fields use AES-256-GCM with a unique 32-byte hex key per environment. Development/tests may use `CUSTOMER_ID_ENCRYPTION_KEY`; live requires `CUSTOMER_ID_ENCRYPTION_KEY_FILE` pointing to a restricted file outside the repository. Backup packages contain the key in plain text because the database is encrypted separately; the server restricts both copies to the service account, local administrators, and system account. Keep both backup locations private and the second copy on separately controlled storage.

## Checks

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e` (requires Playwright Chromium; uses only a separate synthetic test database)

The first bootstrap is intentionally a command-line operation so there is no public registration route. Owners create and deactivate subsequent owner or cashier accounts under **Settings**. Staff can change their own password after signing in.

## Implemented workflows

- Owners can create, search, edit, deactivate, and reactivate products; set Generic or Branded type and independent Senior Citizen/PWD eligibility; record opening stock, receipts, count corrections, and write-offs; and review stock value and immutable history. Existing catalog items are marked unclassified until the owner reviews their type.
- Cashiers can search active products, build a browser cart, preview server-calculated line taxes/discounts, open and close a cashier shift, and finalize an approved cash or QR-declared sale. Live sale finalization remains blocked until the owner records accountant-approved tax and acquisition-cost policy.
- Owners can review immutable sale records, reauthenticate to record a linked full reversal, choose stock restoration per line, and reconcile cash refunds, cash-in/out, and non-zero shift variance decisions. Cash refunds require an open drawer with enough expected cash; QR declarations do not change physical cash.
- Owners can review Manila-day saved-line reports, download formula-safe CSV without customer identifiers, configure the store identity, create two verified backup copies, and restore after owner reauthentication, store-name confirmation, and a verified safety backup. Live backup creation requires absolute local paths and a second physical storage device. Automatic live backups run daily after 02:00 Manila time once the owner has configured the store identity.
- Product gross-profit figures remain estimates. Before approval is recorded, they use a labeled provisional 12% VAT-inclusive assumption; afterward they use the owner's recorded approved tax settings and cost basis, while excluding benefit discounts and operating costs. Checkout is blocked until the owner records accountant-approved tax and cost settings. The test database alone has a clearly synthetic policy fixture. See [implementation status](IMPLEMENTATION_STATUS.md) for pending decisions and release checks.

## Pilot deployment and recovery

Use [docs/DEPLOYMENT_AND_RECOVERY.md](docs/DEPLOYMENT_AND_RECOVERY.md), the [Caddy example](deploy/Caddyfile.example), and the [Linux service template](deploy/medtryx.service.example). The actual server OS, hostname, client browsers, trusted backup media, and certificate trust are still setup decisions; the repository does not configure or deploy a live host.
