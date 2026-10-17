# VPS deployment and recovery

This runbook describes a public VPS deployment behind Caddy. The GitHub workflow builds a release from one exact `v1` revision; it does not deploy automatically on push. The owner must still choose the real host, domain, currency, storage devices, credentials, and access policy before placing pharmacy data on the server.

## Production VPS deployment

### GitHub environment and release workflow

`.github/workflows/ci.yml` runs on pushes to `v1` and pull requests targeting `v1`. It installs the lockfile with Node.js 24, then runs lint, type checking, and workspace builds. `.github/workflows/deploy-vps.yml` is a manual workflow. It accepts only `refs/heads/v1`, builds the dispatched commit SHA, packages its compiled server/web/shared files and migrations, uploads that exact artifact over SSH, then asks the VPS helper to verify its checksum and revision.

In GitHub repository settings, create an environment named `production`. Where the repository's GitHub plan and visibility allow it, restrict the environment's deployment branches to `v1` and configure required reviewers. Store `VPS_HOST` and `VPS_USER` as environment variables. Store `VPS_SSH_PRIVATE_KEY` and `VPS_SSH_KNOWN_HOSTS` as environment secrets. Put the VPS's already verified SSH host key line in `VPS_SSH_KNOWN_HOSTS`; do not populate it from an unverified `ssh-keyscan` in the workflow. The SSH client uses `StrictHostKeyChecking=yes`, disables agent forwarding, and the deployment is serialized. GitHub environments with required reviewers gate access to environment secrets; see [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

GitHub exposes `workflow_dispatch` in the Actions interface only after that workflow file exists on the repository's default branch. This change is intentionally scoped to `v1`; when enabling the workflow on GitHub later, either make `v1` the default branch or separately add the reviewed dispatch workflow descriptor to the default branch. Then select `v1` in the dispatch form. The workflow itself rejects any run whose selected ref is not `refs/heads/v1`. Do not dispatch it until the `production` environment and host secrets are configured. Required reviewer and branch-protection options vary by repository visibility and GitHub plan.

From **Actions → Deploy v1 to VPS → Run workflow**, select the `v1` branch and review the displayed commit before dispatch. The run builds and deploys that commit's immutable SHA. Deployment credentials are used only in the final SSH step. No secrets or credentials belong in this repository.

### Host, domain, and storage preparation

The examples target Ubuntu 24.04 with systemd. Use a VPS with enough local disk for SQLite, releases, and backups, and a separately mounted owner-controlled storage volume for the secondary backup copy. The application database must stay on local disk; do not place SQLite or its WAL files on NFS, SMB, a synced folder, or object storage. The deployment helper refuses to proceed when its two backup roots report the same filesystem device.

Create public DNS A and, if used, AAAA records for the VPS. Allow inbound TCP ports 80 and 443 to Caddy and restrict SSH to administrator/runner source addresses. Caddy obtains and renews a publicly trusted certificate when the domain resolves to the VPS and those ports reach Caddy. See the [Caddy HTTPS prerequisites](https://caddyserver.com/docs/quick-starts/https) and [official Caddy package installation](https://caddyserver.com/docs/install).

Install Node.js 24, npm, the native build tools, SQLite CLI, and Caddy. The SQLite CLI is used for a safe stopped-service `.backup` snapshot before a new application version can open and migrate the database. The Node.js package is installed on Ubuntu as follows (check `node --version`; it must report major version 24):

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg build-essential python3 sqlite3 openssl
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup_24.sh
sudo bash /tmp/nodesource_setup_24.sh
sudo apt-get install -y nodejs
node --version
npm --version
```

Install Caddy from its official Ubuntu package source:

```sh
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Create separate service and deployment identities. The `medtryx` account runs the application; the SSH deployment account uploads a release artifact and receives passwordless sudo for only the root-owned deployment helper.

```sh
sudo useradd --system --user-group --home-dir /var/lib/medtryx --shell /usr/sbin/nologin medtryx
sudo useradd --create-home --user-group --shell /bin/bash medtryx-deploy
sudo install -d -o root -g root -m 0755 /opt/medtryx /opt/medtryx/releases
sudo install -d -o root -g root -m 0755 /etc/medtryx
sudo install -d -o medtryx -g medtryx -m 0700 /var/lib/medtryx /var/backups/medtryx-primary /etc/medtryx/secrets
sudo install -d -o root -g root -m 0755 /mnt/medtryx-backups-secondary
```

Mount a separate filesystem at `/mnt/medtryx-backups-secondary` and configure that mount persistently in `/etc/fstab` using the device UUID supplied by the VPS/storage provider. For an ext4 volume, the fstab entry has this form; replace the UUID with the actual volume UUID. Mount it before continuing. Confirm it is a real mount and that its device identifier differs from the primary location:

```fstab
UUID=replace-with-secondary-volume-uuid /mnt/medtryx-backups-secondary ext4 defaults 0 2
```

```sh
findmnt /mnt/medtryx-backups-secondary
stat -c '%d %n' /var/backups/medtryx-primary /mnt/medtryx-backups-secondary
sudo install -d -o medtryx -g medtryx -m 0700 /mnt/medtryx-backups-secondary
```

If both `stat` values match, stop and attach/mount a distinct volume. The built-in live backup preflight and deployment helper enforce this check; two directories on one filesystem do not count as separate copies.

### Live configuration and service setup

Create a 32-byte customer-data key file with restrictive permissions. The application copies this key alongside verified backups because protected customer IDs cannot be recovered without it. Keep the key out of the release checkout and GitHub; backup copies contain sensitive customer data and this key.

```sh
sudo -u medtryx sh -c 'umask 077; openssl rand -hex 32 > /etc/medtryx/secrets/customer-data.key'
```

Create `/etc/medtryx/medtryx.env` with `sudoedit` and set its owner to root with mode `0600`. Use absolute paths without embedded quotes or spaces. Set the owner email/password only for first-time account bootstrap; remove the password after bootstrap.

```dotenv
APP_ENV=live
NODE_ENV=production
MEDTRYX_CURRENCY=PHP
HOST=127.0.0.1
PORT=3001
COOKIE_SECURE=true
MEDTRYX_DATA_DIR=/var/lib/medtryx
MEDTRYX_BACKUP_PRIMARY_DIR=/var/backups/medtryx-primary
MEDTRYX_BACKUP_SECONDARY_DIR=/mnt/medtryx-backups-secondary
CUSTOMER_ID_ENCRYPTION_KEY_FILE=/etc/medtryx/secrets/customer-data.key
MEDTRYX_OWNER_EMAIL=owner@example.com
MEDTRYX_OWNER_PASSWORD=replace-with-a-unique-password
```

Set `MEDTRYX_CURRENCY=USD` only for a new, empty database and before its first open. Once a currency has been written to database settings it is immutable. Legacy financial data and legacy backups without currency metadata are treated as PHP; a configured mismatch fails before migrations or restore changes. Do not change the environment value to relabel saved amounts. The public `/api/config` response exposes the selected currency to the web app. USD only changes monetary denomination and the provisional unapproved regular-sale tax default to neutral 0%; it does not enable SC/PWD/BNPC benefits or make the product US tax-compliant. Business dates, shift timing, schedules, and backup times remain in Asia/Manila.

The application and generated `medtryx-preflight.service`/`medtryx-bootstrap.service` units use systemd's `EnvironmentFile` to receive this configuration. The main service needs write access to the restricted key directory so an approved application restore can atomically replace the customer-data key; keep that directory owned by `medtryx` with mode `0700` and the key file mode `0600`. Preflight and bootstrap units do not need to write there. Install the examples and the root-owned deploy helper from a reviewed `v1` checkout:

```sh
sudo chown root:root /etc/medtryx/medtryx.env
sudo chmod 0600 /etc/medtryx/medtryx.env
sudo chown medtryx:medtryx /etc/medtryx/secrets/customer-data.key
sudo chmod 0600 /etc/medtryx/secrets/customer-data.key
sudo install -o root -g root -m 0644 deploy/medtryx.service.example /etc/systemd/system/medtryx.service
sudo install -o root -g root -m 0644 deploy/medtryx-preflight.service.example /etc/systemd/system/medtryx-preflight.service
sudo install -o root -g root -m 0644 deploy/medtryx-bootstrap.service.example /etc/systemd/system/medtryx-bootstrap.service
sudo install -o root -g root -m 0750 deploy/medtryx-deploy.sh /usr/local/sbin/medtryx-deploy
sudo systemctl daemon-reload
sudo systemctl enable medtryx.service
```

Install the SSH public key for `medtryx-deploy` in its `~/.ssh/authorized_keys` with normal SSH file permissions and no agent forwarding. Create `/etc/sudoers.d/medtryx-deploy` with `visudo` and this rule so that account can execute only the root-owned deployment helper as root:

```sudoers
medtryx-deploy ALL=(root) NOPASSWD: /usr/local/sbin/medtryx-deploy *
```

The helper validates both arguments, artifact checksum, revision, app paths, and the live preflight before it touches the current release or database. Keep the helper root-owned and non-writable by both the service and deployment accounts.

The helper installs production dependencies in a staging release on the VPS so native SQLite/Argon2 modules match the host Node ABI. It runs the staged `live-preflight` as the service user with a clean environment before stopping the current server. This preflight does not open the database.

### First deployment and owner bootstrap

For first deployment, the configured database path and `/opt/medtryx/current` must not already contain an installation. Run **Deploy v1 to VPS** after the service files, root helper, environment file, and separate backup volume are ready. Since there is no database yet, the helper reports that no pre-migration snapshot applies. The new service's startup creates the schema and applies migrations automatically. Do not run an older server against that database.

Install the Caddy example with the actual public DNS name before the first deployment. This allows you to verify HTTPS after the application becomes healthy:

```sh
sudo install -o root -g root -m 0644 deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
```

The Caddy site should contain the public hostname and `reverse_proxy 127.0.0.1:3001`. Express listens only on loopback. In live mode it trusts proxy headers from loopback only so Caddy can pass the client IP for rate limiting; do not place an untrusted/general-purpose proxy in front of the loopback listener. Open only ports 80 and 443 publicly.

After the workflow reports a healthy service, stop it and run the one-time owner bootstrap through systemd so it receives the same live environment as the service:

```sh
sudo systemctl stop medtryx.service
sudo systemctl start medtryx-bootstrap.service
sudo systemctl status medtryx-bootstrap.service --no-pager
sudoedit /etc/medtryx/medtryx.env
```

Remove `MEDTRYX_OWNER_PASSWORD` from the environment file, save it, then start the service:

```sh
sudo systemctl start medtryx.service
curl --fail --show-error https://medtryx.example.com/api/health
```

Sign in at the public domain, complete the initial store setup, and create a verified application backup to both destinations before recording live sales. The first owner bootstrap is disabled once any user exists. Do not run seed commands as part of an update; products must be entered or imported and reviewed by the owner.
Test the certificate, login, owner/cashier permissions, inventory, checkout, reversals, reports, backup, and restore on the actual planned devices before staff use.

### Routine update

1. Review the proposed migration files and pass the `v1` CI workflow. Close shifts and stop new checkout. The owner should create and verify a manual application backup to both configured destinations before approving a release.
2. Dispatch the manual workflow from `v1` and confirm the exact revision. The workflow packages its built output and uploads it to `/var/tmp`; it runs no database CLI during package creation. Native dependencies are installed while the existing service still runs.
3. The VPS helper runs live preflight, stops `medtryx.service`, and checks that the service is stopped. For an existing database it creates a consistent `.backup` SQLite snapshot, checks `integrity_check` and `foreign_key_check`, copies the snapshot plus the matching customer-data key to both configured roots, and compares SHA-256 hashes. Both paths must remain on different devices. The helper does not call `openDatabase` before this snapshot.
4. Only after the snapshot verifies does the helper atomically change `/opt/medtryx/current` to the exact release and start the new service. Startup applies pending migrations. The helper waits for `/api/health` on loopback. It never starts the old process against a migrated database and never automatically points back to old code after cutover.
5. Confirm `https://<your-domain>/api/health`, sign-in, the owner/cashier workflows and `/api/config` currency. Monitor `journalctl -u medtryx.service` and verify that the owner Backups screen shows a new valid application backup after the release.

The helper's `predeploy-<revision>-<UTC timestamp>` folders are emergency **offline snapshots**, not normal Medtryx backup packages. They contain only `store.sqlite` and `customer-data.key`; they have no Medtryx manifest, are not shown in the Backups screen, and cannot be restored through the UI. Keep the independently verified application backup too. Protect both copies as sensitive customer data. The deployment helper preserves old code releases for inspection and does not prune them automatically.

### Failed deployment and rollback

If an error occurs before cutover, the helper deletes the unused staged release and restarts the previous service if it was running; the live database has not been opened by new code. If an error occurs after the current symlink changes, the helper stops the new service, leaves that release selected, and retains all database snapshots. Read `systemctl status medtryx.service` and `journalctl -u medtryx.service` before deciding what to do. A failed artifact after cutover cannot be redeployed under the same SHA; make and review a new `v1` commit for a fix-forward release, or start the selected release manually after resolving an external/transient issue.

Do not automatically switch the symlink to old code after a migration. First inspect the database migration list and compare the older release's supported schema/data behavior. A code-only rollback is safe only when the old code is known to support every schema migration already applied and all new stored data; this compatibility must be verified for that specific release. Otherwise keep the service stopped and fix forward, or conduct a deliberate restore with the matching application release.

To recover from a migration failure using a deployment snapshot, stop the service and preserve the failed `live.sqlite`, its WAL/SHM files if present, and current key file in a separate restricted quarantine directory. Choose one verified pre-deploy copy from the matching timestamp, restore both its `store.sqlite` and `customer-data.key` to the configured live paths with owner `medtryx:medtryx` and mode `0600`, then start only an application release compatible with that snapshot's recorded migration list. The SQLite `.backup` snapshot is self-contained and must not be combined with old `-wal`/`-shm` files; move those aside with the failed database before installing it. Record the selected revision and database snapshot, validate the application and known records, then create a fresh application backup. Never delete either snapshot or make a best-guess migration rollback on a live database.

If the owner restores from **Backups** in the running application, its normal workflow validates the package and currency and creates a safety backup before applying it. Cross-currency backup restoration is rejected before the safety backup or database is changed. A pre-currency legacy backup without a currency setting is PHP. Offline deployment snapshots are for stopped-service disaster recovery, not the UI restore workflow.

## Private-network pilot

For a private site, follow the same Node.js 24, dedicated service account, local SQLite, two-device backup, and systemd setup above. Use a stable private hostname and replace the public site block in `deploy/Caddyfile.example` with this Caddy configuration:

```caddyfile
medtryx.example.lan {
  tls internal
  encode zstd gzip
  reverse_proxy 127.0.0.1:3001
}
```

Install Caddy's local root certificate into each authorized device's trusted certificate store using a secure, administrator-managed process. Restrict access to the private network at the firewall. Keep Express bound to loopback. Feature behavior and operating procedures belong to the [v1 specification](V1_SPECIFICATION.md).

## Application backups and restore

After initial store setup, Medtryx creates a daily backup after 02:00 Asia/Manila while the live service is running. Owners can also create a backup from **Backups**. The app verifies the database and copies each backup to both configured storage devices. Monitor the latest valid backup and free space; keep one copy physically protected when practical. The package includes the customer-data key required to recover encrypted customer identifiers.

A restore through **Backups** checks the package, store identity, environment, currency, integrity, and key, then creates a safety backup to both destinations before replacing the database. A legacy backup without currency metadata is PHP. A PHP/USD mismatch is rejected. Offline `predeploy-*` snapshots are for stopped-service disaster recovery and cannot be restored through the app.

Review migration files before release. The application applies migrations during startup, so keep the service stopped while making a database snapshot and never start old code against a database that newer code may have migrated. For an offline restore, preserve the failed database and its WAL/SHM files separately, then restore a verified matching database-and-key snapshot. The SQLite `.backup` file is self-contained and must not be combined with the failed database's WAL/SHM files. Confirm the restored app release supports that schema, verify known records, then create a new application backup. Use the [v1 specification](V1_SPECIFICATION.md) for product behavior and any version-specific operational detail.
