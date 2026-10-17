#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly APP_ROOT=/opt/medtryx
readonly RELEASES_DIR="$APP_ROOT/releases"
readonly CURRENT_LINK="$APP_ROOT/current"
readonly ENV_FILE=/etc/medtryx/medtryx.env
readonly SERVICE=medtryx.service
readonly SERVICE_USER=medtryx
staging_dir=
release_dir=
release_published=false
service_was_active=false
cutover=false
deployment_succeeded=false

die() {
  printf 'Medtryx deployment stopped: %s\n' "$1" >&2
  exit 1
}

finish() {
  local status=$?
  if [[ "$status" -ne 0 && "$deployment_succeeded" != true ]]; then
    if [[ "$cutover" == true ]]; then
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      printf 'The new release remains selected; it may have migrated the database. Do not switch to older code automatically.\n' >&2
    elif [[ "$service_was_active" == true ]]; then
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$release_published" == true && "$cutover" != true ]]; then
      rm -rf "$release_dir"
    fi
  fi
  if [[ -n "$staging_dir" && -d "$staging_dir" ]]; then
    rm -rf "$staging_dir"
  fi
  trap - EXIT
  exit "$status"
}
trap finish EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  die "run this helper through sudo"
fi
if [[ $# -ne 2 ]]; then
  die "usage: medtryx-deploy <40-character-git-revision> <artifact-sha256>"
fi

revision=$1
expected_sha=$2
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || die "invalid revision"
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die "invalid artifact checksum"

artifact="/var/tmp/medtryx-${revision}.tar.gz"
[[ -f "$artifact" ]] || die "release artifact was not uploaded"
actual_sha=$(sha256sum "$artifact" | cut -d ' ' -f 1)
[[ "$actual_sha" == "$expected_sha" ]] || die "release artifact checksum mismatch"
[[ -r "$ENV_FILE" ]] || die "live EnvironmentFile is missing"
[[ -x /usr/bin/node ]] || die "Node.js must be installed at /usr/bin/node"
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" == 24 ]] || die "Node.js 24 is required"
command -v sqlite3 >/dev/null || die "sqlite3 CLI is required for safe pre-migration snapshots"
command -v curl >/dev/null || die "curl is required for the post-start health check"
command -v findmnt >/dev/null || die "findmnt is required to verify the secondary backup mount"
command -v runuser >/dev/null || die "runuser is required to install as the service account"
command -v flock >/dev/null || die "flock is required to serialize deployments"
id "$SERVICE_USER" >/dev/null 2>&1 || die "service account medtryx is missing"
[[ -d "$RELEASES_DIR" && -d "$APP_ROOT" ]] || die "application directories are not initialized"
exec 9>/run/lock/medtryx-deploy.lock
flock -n 9 || die "another deployment helper is already running"

archive_entries=$(tar -tzf "$artifact")
for required in REVISION package.json package-lock.json apps/server/package.json \
  apps/server/dist/index.js apps/server/dist/cli/live-preflight.js \
  apps/web/package.json apps/web/dist/index.html packages/shared/package.json \
  packages/shared/dist/index.js; do
  grep -Fxq "$required" <<<"$archive_entries" || die "artifact is missing $required"
done
grep -Eq '^database/migrations/?$' <<<"$archive_entries" || die "artifact is missing database/migrations"
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$archive_entries"; then
  die "release artifact contains an unsafe path"
fi
if tar -tvzf "$artifact" | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { found = 1 } END { exit !found }'; then
  die "release artifact contains a non-file entry"
fi

release_dir="$RELEASES_DIR/$revision"
[[ ! -e "$release_dir" ]] || die "release already exists; use a new revision"
staging_dir="$RELEASES_DIR/.staging-$revision-$$"
mkdir -m 0755 "$staging_dir"
tar -xzf "$artifact" -C "$staging_dir" --no-same-owner --no-same-permissions
[[ "$(<"$staging_dir/REVISION")" == "$revision" ]] || die "artifact revision does not match request"

# Install production dependencies on the VPS so native modules match its Node ABI.
chown -R "$SERVICE_USER:$SERVICE_USER" "$staging_dir"
runuser -u "$SERVICE_USER" -- sh -c \
  "cd '$staging_dir' && /usr/bin/npm ci --omit=dev --no-audit --no-fund"
mv "$staging_dir" "$release_dir"
staging_dir=
release_published=true

read_env_value() {
  local key=$1 value
  value=$(awk -v wanted="$key" 'index($0, wanted "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")
  value=${value%$'\r'}
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  [[ "$value" != *$'\n'* ]] || die "$key contains an unsupported character"
  printf '%s' "$value"
}

absolute_env_value() {
  local key=$1 value
  value=$(read_env_value "$key")
  [[ -n "$value" && "$value" == /* ]] || die "$key must be an absolute path in $ENV_FILE"
  [[ "$value" != *"'"* ]] || die "$key contains an unsupported quote"
  printf '%s' "$value"
}

app_env=$(read_env_value APP_ENV)
node_env=$(read_env_value NODE_ENV)
host=$(read_env_value HOST)
cookie_secure=$(read_env_value COOKIE_SECURE)
port=$(read_env_value PORT)
currency=$(read_env_value MEDTRYX_CURRENCY)
[[ "$app_env" == live && "$node_env" == production ]] || die "APP_ENV=live and NODE_ENV=production are required in $ENV_FILE"
[[ "$host" == 127.0.0.1 && "$cookie_secure" == true ]] || die "HOST=127.0.0.1 and COOKIE_SECURE=true are required in $ENV_FILE"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || die "PORT must be between 1 and 65535"
[[ -z "$currency" || "$currency" == PHP || "$currency" == USD ]] || die "MEDTRYX_CURRENCY must be PHP or USD when set"

data_dir=$(absolute_env_value MEDTRYX_DATA_DIR)
primary_dir=$(absolute_env_value MEDTRYX_BACKUP_PRIMARY_DIR)
secondary_dir=$(absolute_env_value MEDTRYX_BACKUP_SECONDARY_DIR)
key_file=$(absolute_env_value CUSTOMER_ID_ENCRYPTION_KEY_FILE)
db_file="$data_dir/live.sqlite"
findmnt --mountpoint "$secondary_dir" >/dev/null || die "secondary backup path must be a mounted filesystem"
mkdir -p "$primary_dir/live" "$secondary_dir/live"
chown "$SERVICE_USER:$SERVICE_USER" "$primary_dir/live" "$secondary_dir/live"
chmod 0700 "$primary_dir/live" "$secondary_dir/live"
primary_device=$(stat -c '%d' "$primary_dir/live")
secondary_device=$(stat -c '%d' "$secondary_dir/live")
[[ "$primary_device" != "$secondary_device" ]] || die "live backup roots are on the same storage device"

# This command reads configuration and the key file only; it does not open the database.
runuser -u "$SERVICE_USER" -- /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  APP_ENV="$app_env" NODE_ENV="$node_env" HOST="$host" \
  COOKIE_SECURE="$cookie_secure" PORT="$port" \
  MEDTRYX_CURRENCY="$currency" \
  MEDTRYX_DATA_DIR="$data_dir" \
  MEDTRYX_BACKUP_PRIMARY_DIR="$primary_dir" \
  MEDTRYX_BACKUP_SECONDARY_DIR="$secondary_dir" \
  CUSTOMER_ID_ENCRYPTION_KEY_FILE="$key_file" \
  /usr/bin/node "$release_dir/apps/server/dist/cli/live-preflight.js"

previous_release=
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release=$(readlink -f "$CURRENT_LINK")
elif [[ -e "$CURRENT_LINK" ]]; then
  die "current must be a symlink"
fi

systemctl is-active --quiet "$SERVICE" && service_was_active=true || true
systemctl stop "$SERVICE"
if systemctl is-active --quiet "$SERVICE"; then
  die "service did not stop; database remains untouched"
fi

if [[ -e "$db_file" ]]; then
  [[ -n "$previous_release" ]] || die "database exists without a current release; review first-deploy state manually"
  [[ -r "$key_file" ]] || die "live customer key file is unreadable"
  [[ "$db_file" != *"'"* && "$db_file" != *$'\n'* ]] || die "database path contains an unsupported character"
  snapshot_id="predeploy-${revision}-$(date -u +%Y%m%dT%H%M%SZ)"
  primary_snapshot="$primary_dir/live/$snapshot_id"
  secondary_snapshot="$secondary_dir/live/$snapshot_id"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$primary_snapshot" "$secondary_snapshot"
  temp_snapshot="$primary_snapshot/store.sqlite.tmp"
  sqlite3 -batch "$db_file" ".backup '$temp_snapshot'"
  integrity=$(sqlite3 -batch "$temp_snapshot" 'PRAGMA integrity_check;')
  [[ "$integrity" == "ok" ]] || die "pre-migration snapshot integrity check failed"
  foreign_keys=$(sqlite3 -batch "$temp_snapshot" 'PRAGMA foreign_key_check;')
  [[ -z "$foreign_keys" ]] || die "pre-migration snapshot foreign-key check failed"
  mv "$temp_snapshot" "$primary_snapshot/store.sqlite"
  chown "$SERVICE_USER:$SERVICE_USER" "$primary_snapshot/store.sqlite"
  chmod 0600 "$primary_snapshot/store.sqlite"
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 "$key_file" "$primary_snapshot/customer-data.key"
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 "$primary_snapshot/store.sqlite" "$secondary_snapshot/store.sqlite"
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 "$key_file" "$secondary_snapshot/customer-data.key"
  primary_db_sha=$(sha256sum "$primary_snapshot/store.sqlite" | cut -d ' ' -f 1)
  secondary_db_sha=$(sha256sum "$secondary_snapshot/store.sqlite" | cut -d ' ' -f 1)
  primary_key_sha=$(sha256sum "$primary_snapshot/customer-data.key" | cut -d ' ' -f 1)
  secondary_key_sha=$(sha256sum "$secondary_snapshot/customer-data.key" | cut -d ' ' -f 1)
  [[ "$primary_db_sha" == "$secondary_db_sha" && "$primary_key_sha" == "$secondary_key_sha" ]] || die "dual snapshot copies did not verify"
  printf 'Verified pre-migration snapshot copies: %s and %s\n' "$primary_snapshot" "$secondary_snapshot"
elif [[ -n "$previous_release" ]]; then
  die "an existing installation has no database file; refusing to treat it as a fresh install"
else
  printf 'Fresh installation: no database exists, so no pre-migration snapshot is applicable.\n'
fi

next_link="$APP_ROOT/.current-$revision"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$CURRENT_LINK"
cutover=true
if ! systemctl start "$SERVICE"; then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  die "new service failed to start"
fi

healthy=false
for _ in $(seq 1 30); do
  if response=$(curl --connect-timeout 2 --max-time 5 --silent --show-error --fail "http://127.0.0.1:$port/api/health" 2>/dev/null) && \
    /usr/bin/node -e 'const r=JSON.parse(process.argv[1]); process.exit(r.status === "ok" && r.environment === "live" ? 0 : 1)' "$response"; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  systemctl stop "$SERVICE" || true
  printf 'Health check failed. The new release remains selected and may have applied migrations. Do not switch to older code automatically; follow docs/DEPLOYMENT_AND_RECOVERY.md.\n' >&2
  exit 1
fi

deployment_succeeded=true
rm -f "$artifact"
printf 'Deployment healthy at revision %s. Previous release: %s\n' "$revision" "${previous_release:-none}"
