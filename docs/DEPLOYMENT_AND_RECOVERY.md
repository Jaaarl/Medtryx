# Local pilot deployment and recovery

This guide prepares a single local server behind Caddy. It does not deploy or configure a live pharmacy. Select the actual host, network name, planned browsers, and owner-controlled backup media before following it.

## Host and network requirements

- Use a supported desktop/server OS with Node.js 24 LTS and Caddy installed as services that start at boot.
- Keep the SQLite database on the server's local disk. Do not put the database or its WAL files on a shared drive, NAS, or synced folder.
- Give Express only a loopback listener (`HOST=127.0.0.1`). Caddy is the only network-facing web service; restrict HTTPS access with the host firewall to the private pharmacy network.
- Configure a stable private DNS name or host mapping for the server. The name in `deploy/Caddyfile.example` is a placeholder.
- Use one restricted operating-system account for the Medtryx service. The server applies directory and file permissions to its data and backup folders. On Windows, it grants access to that service identity, local Administrators, and SYSTEM. On POSIX systems, directories use mode `0700` and files use `0600`.
- Keep the secondary backup location on separate storage controlled by the owner. Do not use a public download folder, synced cloud folder, or general shared network folder. The live service compares storage device identifiers and refuses to create a live backup when both configured paths resolve to the same device.

## Live environment configuration

Copy `.env.example` to `.env` beside the application and apply restrictive permissions to the file. Never commit it. Generate a unique 32-byte key for the live environment (for example, `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) and store its 64-character hexadecimal value in a separate restricted file outside the repository and outside the database directory. Point `CUSTOMER_ID_ENCRYPTION_KEY_FILE` to that file. The key file is included as plain text in each unencrypted backup package so a recovery can decrypt authorized SC/PWD records.

Set these live values in `.env`:

```dotenv
APP_ENV=live
NODE_ENV=production
HOST=127.0.0.1
COOKIE_SECURE=true
MEDTRYX_DATA_DIR=/var/lib/medtryx
MEDTRYX_BACKUP_PRIMARY_DIR=/var/backups/medtryx-primary
MEDTRYX_BACKUP_SECONDARY_DIR=/mnt/medtryx-backups-secondary
CUSTOMER_ID_ENCRYPTION_KEY_FILE=/etc/medtryx/secrets/customer-data.key
```

Use absolute paths on the actual host. The database and both backup roots must be separate paths outside the repository. Medtryx creates an environment-specific child directory under each configured backup root, keeping development, test, and live packages apart. The live server refuses to start if the backup roots are missing, overlap, share the same filesystem/device identifier, or are inside the repository. It also requires a readable key file, secure cookies, and an Express loopback bind. The identifier check catches the same volume/filesystem but cannot prove that two volumes are separate physical devices; the owner must check the actual media. Create the root directories and grant the service account permission to use them before starting the service. Do not point the database to a network-mounted path.

Run the non-mutating environment check after Node.js 24 and dependencies are installed:

```powershell
npm run live:preflight
```

The preflight checks Node version, environment, absolute paths, directory separation, distinct storage device IDs, loopback bind, secure cookies, and key-file format. It does not prove a disk is physically local, verify the host firewall, configure Caddy, or test client devices.

Apply migrations and create the first owner only after reviewing the live paths and secrets:

```powershell
npm run db:migrate
npm run db:create-owner
npm run build
```

Before applying a release that adds the single-register constraint to an existing database, make a verified backup and rehearse the migration on a restored copy. Migration `0008_single_store_register.sql` requires zero or one open shift. If the existing database has more than one, the migration fails atomically: it does not close shifts or change their counts, and the earlier per-cashier constraint remains in place. Stop the upgrade, have each cashier close the correct drawer using its physical cash count and the owner's reconciliation procedure, verify that no shift remains open, create a fresh verified backup, then retry the migration. Never resolve this by inventing a count or deleting a shift.

For migration `0010_lot_expiry.sql` and later releases that alter lot, bundle, or BNPC data, make a verified backup and test the upgrade and restore on a copy before touching live data. Migration `0010` first requires each existing product's quantity and inventory value to reconcile with its stock-event ledger; if that check fails, the migration rolls back. Resolve the pre-existing mismatch against physical records before retrying. On a valid upgrade, the migration preserves historical product quantity, inventory value, and stock events but assigns no lot codes or expiry dates to existing units. They remain visible as unallocated legacy stock. If the owner marks a product as lot-tracked, those units cannot be sold until an owner physically verifies the actual batch label, printed expiry, and quantity and records a reasoned reconciliation. Do not infer or type a plausible batch number or expiry to make the software totals saleable. Any unresolved quantity stays unallocated and is excluded from checkout until physical evidence is available. Reconciliation preserves total SKU quantity and value, distributing book value to reconciled units at the current weighted-average SKU cost; it does not introduce lot-specific COGS. Keep the regular receipt flow for non-tracked products.

## Virtual bundle offers

Only the owner creates, edits, or activates/deactivates offers in **Bundles**. An offer has a unique code, name, Manila active dates, component SKUs and quantities, an optional maximum quantity **per sale**, and a promotional price. The owner may calculate a suggested price from a percentage or fixed-amount reduction, edits the final price, then checks the explicit price-approval box before saving. Editing saves a new immutable version; previous sales retain the version they used. A bundle is an offer only: never receive stock against its code or count it as a separate product.

At checkout, the cashier selects the offer and quantity. Medtryx expands it into the component products and checks stock across the whole cart. For tracked components, pick the assigned lots and confirm the physical labels before confirming the sale. Review the regular component prices, promotional allocations, and each component's promotional-versus-statutory result. The more favorable allowed treatment is used per component and the discounts are not stacked; statutory treatment can make the payable total differ from the advertised bundle price. If price, date, per-sale limit, or component stock is no longer valid, remove or reduce the offer and preview again. A sale reversal is still processed against each original component line, with the existing lot-verification/restock or write-off choice. Bundle discounts appear separately in reports and CSV. Do not treat the internal Medtryx sale as an official invoice.

Set `MEDTRYX_OWNER_EMAIL` and a unique `MEDTRYX_OWNER_PASSWORD` in the restricted environment file for the one-time owner bootstrap, then remove the bootstrap password. Run database migration/bootstrap commands under the same dedicated operating-system account that will run the service; folder ACLs are restricted to the account executing these commands, local administrators, and system account. The server must run as a service under that same account. `deploy/medtryx.service.example` provides a Linux systemd template; fill in the real paths and service identity. On Windows, configure the selected Windows service manager or Task Scheduler to run `node apps/server/dist/index.js` at startup under the dedicated service account.

## Caddy and browser trust

Copy `deploy/Caddyfile.example` to the selected Caddy configuration location and replace the placeholder hostname. Start Caddy as a service, confirm it can reach `127.0.0.1:3001`, and allow only the private network through the firewall. Do not expose the Express port directly.

With `tls internal`, Caddy issues a local certificate. Securely install Caddy's local root certificate into the trust store on every cashier and owner device. Then test the final hostname, certificate trust, sign-in, checkout, owner inventory, reversal, reports, backup, and restore using the actual planned browsers and network. The automated Playwright run uses desktop Chromium over local HTTP; it does not satisfy this physical-device release gate.

## Daily backups

After the store identity is saved by the owner, Medtryx creates a daily automatic backup after 02:00 Asia/Manila when the live service is running. Owners can also choose **Backups → Create backup now**. Each package contains:

- a consistent SQLite online backup with active sessions removed;
- the 32-byte customer field-encryption key in plain text;
- a manifest with the store identity, environment, Manila date, migration list, purpose, and SHA-256 checksums.

The same package is copied to both configured destinations. Creation fails if either copy cannot be secured or if live storage is not separate. The owner screen lists the copies only after checksum, database integrity, foreign-key, and encrypted-customer-record checks pass. Backups are not downloadable through the browser. Monitor disk capacity and the latest automatic backup in the owner screen. Keep one secondary storage device disconnected or physically protected when practical, and record who can access it.

The live app requires the backup to use the same `APP_ENV` when restoring. This prevents a live database from being restored into the development/test database. Use synthetic records for development and restore rehearsals. Never copy a live package into development or test because it contains customer data and the live decryption key.

## Restore procedure

1. Stop cashier checkout and notify staff that recovery is starting. Keep the server on the private network.
2. If the current server still runs, open **Backups** and select a verified copy. Confirm the displayed store identity and date. Type the store name and enter the current owner password.
3. Medtryx validates the package, schema, checksums, customer-data key, authorized owner, database integrity, and foreign keys. It then makes a safety backup of the current state to both configured destinations.
4. Restore replaces the current inventory, sales, shifts, settings, and audit history with the selected snapshot; all staff sessions are revoked. Sign in again after the confirmation screen.
5. Compare a known synthetic sale, its saved COGS, product quantity/value, reversal or write-off, and selected-day report with the package manifest and paper records.
6. Verify both the restored package and the new safety package appear as valid copies. Keep staff on manual outage procedures until the owner accepts the reconciliation.

For a clean replacement server, first install the same release, configure separate empty live paths, restore the owner-managed environment/key file, apply the matching application version, create a bootstrap owner, and configure the store. Do not make the server available to staff until the restored store identity is confirmed. Restore tests must use a dedicated isolated test host with synthetic data and paths on separate test media; they must not use a live customer backup.

If a restore fails validation, Medtryx leaves the current database unchanged and reports a safe error code. Do not delete either backup copy. Preserve both copies and the manifest, investigate storage or key problems, then retry from the other verified copy. After any software upgrade, test a synthetic backup and restore against the new release before returning the service to staff.

## Update and rollback

1. Close shifts and stop new checkout before maintenance.
2. Create and verify a manual backup on both locations.
3. Build the new release on a separate workspace with Node.js 24. Review migrations and run the full synthetic test and browser suite.
4. Run migrations against a restored copy of the latest backup first. Preserve the previous application release.
5. Stop the service, deploy the new build, run the migration against live, and start the service. Confirm health and owner/cashier permissions.
6. If the release fails, stop the service. Restore the pre-upgrade backup with a compatible application release, then investigate before reopening checkout.

## Physical release checks

The following require the owner's actual site and cannot be inferred from repository tests:

- store computer OS, stable private address/name, firewall, and local network failure/recovery;
- physical confirmation that database storage is local and the secondary backup is separate owner-controlled media;
- local HTTPS certificate trust and checkout/owner workflows on every planned browser device;
- owner/accountant/professional approval of tax, discount, supplier-cost, invoicing, privacy, retention, and any registration requirements;
- if an existing database contains multiple open shifts, the owner must reconcile the active physical drawers and approve the counts before the single-register migration can be applied;
- physical verification of tracked opening stock and legacy reconciliation, expiry checks and FEFO picking, exact-lot disposal/reversal, any approved booklet/prior-purchase procedure, manual invoicing, outage/recovery procedures, and staff training.
