# Medtryx

Medtryx is a single-store sales and inventory application for small shops. The current v1 behavior and limits are described in the [V1 product and feature specification](docs/V1_SPECIFICATION.md). VPS deployment and recovery instructions are in [docs/DEPLOYMENT_AND_RECOVERY.md](docs/DEPLOYMENT_AND_RECOVERY.md).

## Local development setup

Use Node.js 24. From the repository root, follow this sequence for a new local development database:

1. Install the lockfile dependencies: `npm ci`.
2. Copy `.env.example` to `.env`. Set `APP_ENV=development`, choose `MEDTRYX_CURRENCY=PHP` or `USD`, and set a unique `MEDTRYX_OWNER_EMAIL` and `MEDTRYX_OWNER_PASSWORD` for the one-time initial owner. Set USD only before opening a new, empty database.
3. Run `npm run db:migrate` to initialize the selected local database.
4. Run `npm run db:create-owner` to create the first owner account in that database. This command refuses to add an owner if the selected environment already has users. Remove `MEDTRYX_OWNER_PASSWORD` from `.env` after bootstrap.
5. Start the application with `npm run dev`.

The web application is served at `http://127.0.0.1:5173`. The API listens at `http://127.0.0.1:3001` and the development web server proxies `/api` requests to it. The first sale requires an owner to record the store's approved regular-sale tax, cash-rounding, and acquisition-cost policy. Sale previews before approval are provisional and checkout is blocked.

### Local environment variables

| Variable                 | Local use                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                | Selects the isolated `development`, `test`, or `live` database. Defaults to `development`; non-live files are stored in `data/<environment>.sqlite` unless `MEDTRYX_DATA_DIR` is set.                         |
| `MEDTRYX_CURRENCY`       | `PHP` (default) or `USD`; applies only when a new, empty database is first opened. The saved database currency is immutable.                                                                                  |
| `MEDTRYX_OWNER_EMAIL`    | Email for the one-time first owner bootstrap.                                                                                                                                                                 |
| `MEDTRYX_OWNER_PASSWORD` | Unique password for the one-time first owner bootstrap; remove it after use.                                                                                                                                  |
| `HOST`, `PORT`           | API bind address and port; local defaults are `127.0.0.1` and `3001`.                                                                                                                                         |
| `COOKIE_SECURE`          | Keep `true` for HTTPS. For local development over plain HTTP, set `false`; if exposing the dev server to a LAN over HTTP, do so only on a trusted network. Live deployments must keep secure cookies enabled. |
| `MEDTRYX_DATA_DIR`       | Optional absolute database directory for development; live requires a dedicated absolute path outside the repository.                                                                                         |

`CUSTOMER_ID_ENCRYPTION_KEY` is needed when saving protected customer benefit IDs in local development; use a unique key for each environment. `MIXROUTE_API_KEY` is optional and enables external receipt OCR. Live backup paths, key-file configuration, and service settings are covered by the deployment runbook. Do not copy `.env` or production data into Git.

## Current workflows

- Owners maintain the catalog, import and export CSV, receive inventory, track lots and expiry, record corrections and write-offs, and manage component-based bundle offers.
- Cashiers record sales in the single store-wide open shift. Cash and QR are staff-declared payment methods. Owners review shifts, refunds, payment corrections, and checkout stock-count overrides.
- Owners and cashiers record supported expenses. Supplier stock-purchase/COD payments, product costs, delivery fees, and drawer cash movements are tracked distinctly to avoid deducting inventory cost twice.
- Owners use reports, formula-safe CSV exports, paginated sales history, the activity log, and an editable daily sales journal for operational review.
- Owners may use external receipt OCR to prepare editable suggestions; every suggestion requires review before it changes inventory.
- Owners configure staff, store policy, and backups. Backups contain sensitive database data and the customer-ID encryption key; protect the packages and follow the recovery runbook.

## Current documentation

- [V1 product and feature specification](docs/V1_SPECIFICATION.md)
- [VPS deployment and recovery](docs/DEPLOYMENT_AND_RECOVERY.md)
- [V1 implementation plan and validation record](docs/V1_PLAN.md)

Older product specifications, roadmaps, status snapshots, and planning prompts are historical and should not be used as release guidance.

## Project checks

The repository provides `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Run the checks appropriate for the revision under review; this README does not claim that a particular revision has passed them.
