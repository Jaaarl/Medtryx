import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  DatabaseBackup,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "./api";

type StoreProfile = { id: string; name: string };
type BackupCopy = {
  location: "primary" | "secondary";
  valid: boolean;
  error?: string;
};
type Backup = {
  backupId: string;
  environment: string;
  purpose: "manual" | "automatic" | "safety";
  createdAt: string;
  businessDate: string;
  store: StoreProfile;
  copies: BackupCopy[];
};
type BackupStatus = {
  environment: string;
  storeConfigured: boolean;
  store: StoreProfile | null;
  customerEncryptionKeyConfigured: boolean;
  primaryDirectoryReady: boolean;
  secondaryDirectoryReady: boolean;
  secondaryOnSeparateDevice: boolean;
  ready: boolean;
};

function formatTime(value: string): string {
  return value
    ? new Date(value).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown date";
}

function purposeLabel(purpose: Backup["purpose"]): string {
  return {
    manual: "Owner created",
    automatic: "Automatic",
    safety: "Before restore",
  }[purpose];
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The request could not be completed.";
  const messages: Record<string, string> = {
    backup_paths_not_configured:
      "The server backup locations are not configured.",
    store_profile_required: "Set the store name before creating a backup.",
    customer_encryption_key_not_configured:
      "The customer data encryption key is unavailable.",
    secondary_backup_must_be_on_separate_storage:
      "The live secondary backup location must be on separate storage.",
    reauthentication_failed: "The owner password was not accepted.",
    restore_store_confirmation_mismatch:
      "The store confirmation did not match this backup.",
    backup_environment_mismatch: "This backup belongs to another environment.",
  };
  return (
    messages[error.code] ?? "The backup could not be verified or completed."
  );
}

export function BackupsPage() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [profileName, setProfileName] = useState("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [copyLocation, setCopyLocation] = useState<"primary" | "secondary">(
    "primary",
  );
  const [confirmName, setConfirmName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedBackup = useMemo(
    () => backups.find((backup) => backup.backupId === selectedId) ?? null,
    [backups, selectedId],
  );
  const restorableCopies =
    selectedBackup?.copies.filter((copy) => copy.valid) ?? [];

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [statusResponse, profileResponse] = await Promise.all([
        api.get<{ status: BackupStatus }>("/backups/status"),
        api.get<{ profile: StoreProfile | null }>("/settings/store-profile"),
      ]);
      setStatus(statusResponse.status);
      setProfileName(profileResponse.profile?.name ?? "");
      try {
        const backupResponse = await api.get<{ backups: Backup[] }>("/backups");
        setBackups(backupResponse.backups);
      } catch (caught) {
        setBackups([]);
        if (
          !(caught instanceof ApiError) ||
          caught.code !== "backup_paths_not_configured"
        )
          throw caught;
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Loading protected settings and backup metadata is the intended synchronization effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.put("/settings/store-profile", { name: profileName });
      setNotice("Store identity saved.");
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createManualBackup() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{ backup: Backup }>("/backups", {});
      setNotice(
        `Backup ${result.backup.backupId} was created and verified in both locations.`,
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBackup || confirmName.trim() !== selectedBackup.store.name) {
      setError("Type the store name shown on the selected backup to confirm.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{
        safetyBackupId: string;
        reauthenticationRequired: boolean;
      }>("/backups/restore", {
        backupId: selectedBackup.backupId,
        location: copyLocation,
        confirmStoreId: selectedBackup.store.id,
        ownerPassword,
      });
      setNotice(
        `Restore completed. Safety backup ${result.safetyBackupId} was created. Sign in again to continue.`,
      );
      setOwnerPassword("");
      window.setTimeout(() => window.location.assign("/login"), 1800);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const latestAutomatic = backups.find(
    (backup) => backup.purpose === "automatic",
  );

  return (
    <section className="page-section backups-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER RECOVERY CONTROLS</div>
          <h1>Backups and restore</h1>
          <p>
            Manage the recovery identity, check protected backup copies, and
            verify a restore.
          </p>
        </div>
        <span className="secure-badge">
          <ShieldCheck size={15} /> OWNER ACCESS
        </span>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <div className="table-loading">Loading backup status…</div>
      ) : (
        <>
          <div className="backup-layout">
            <section className="settings-main-card">
              <div className="card-heading">
                <div>
                  <h2>Store identity</h2>
                  <p>
                    This stable identity is written into every backup manifest.
                  </p>
                </div>
              </div>
              <form
                className="backup-profile-form"
                onSubmit={(event) => void saveProfile(event)}
              >
                <label className="inventory-field">
                  <span>Store name</span>
                  <input
                    aria-label="Store name"
                    className="text-input"
                    maxLength={160}
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    required
                  />
                </label>
                {status?.store && (
                  <small className="field-hint">
                    Store ID: {status.store.id}
                  </small>
                )}
                <button
                  className="button button-primary"
                  disabled={busy}
                  type="submit"
                >
                  Save store identity
                </button>
              </form>
            </section>

            <section className="settings-main-card">
              <div className="card-heading">
                <div>
                  <h2>Backup readiness</h2>
                  <p>
                    {status?.ready
                      ? "Both configured locations are ready."
                      : "Complete setup before relying on backups for recovery."}
                  </p>
                </div>
                <span
                  className={`status-pill ${status?.ready ? "status-active" : "status-planned"}`}
                >
                  {status?.ready ? "READY" : "SETUP NEEDED"}
                </span>
              </div>
              <div className="backup-readiness-list">
                <div>
                  <span>Environment</span>
                  <strong>{status?.environment}</strong>
                </div>
                <div>
                  <span>Store identity</span>
                  <strong>
                    {status?.storeConfigured ? "Configured" : "Not configured"}
                  </strong>
                </div>
                <div>
                  <span>Customer data key</span>
                  <strong>
                    {status?.customerEncryptionKeyConfigured
                      ? "Available"
                      : "Unavailable"}
                  </strong>
                </div>
                <div>
                  <span>Primary backup location</span>
                  <strong>
                    {status?.primaryDirectoryReady ? "Ready" : "Not ready"}
                  </strong>
                </div>
                <div>
                  <span>Second backup location</span>
                  <strong>
                    {status?.secondaryDirectoryReady ? "Ready" : "Not ready"}
                  </strong>
                </div>
                <div>
                  <span>Separate storage device</span>
                  <strong>
                    {status?.secondaryOnSeparateDevice
                      ? "Verified"
                      : "Not verified"}
                  </strong>
                </div>
                <div>
                  <span>Latest automatic backup</span>
                  <strong>
                    {latestAutomatic
                      ? formatTime(latestAutomatic.createdAt)
                      : "No automatic backup found"}
                  </strong>
                </div>
              </div>
              <div className="backup-card-actions">
                <button
                  className="button button-primary"
                  onClick={() => void createManualBackup()}
                  disabled={busy || !status?.ready}
                  type="button"
                >
                  <DatabaseBackup size={16} /> Create backup now
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => void load()}
                  disabled={busy}
                  type="button"
                >
                  <RefreshCw size={16} /> Refresh status
                </button>
              </div>
              <p className="field-hint backup-security-note">
                Packages are unencrypted and contain the customer data key. The
                server restricts access to the running service account, local
                administrators, and system account. Do not place backup folders
                in shared or public locations.
              </p>
            </section>
          </div>

          <section className="settings-main-card backup-history-card">
            <div className="card-heading">
              <div>
                <h2>Verified backup copies</h2>
                <p>
                  Each copy is checked against its manifest and database
                  integrity before restore.
                </p>
              </div>
              <span className="count-chip">{backups.length} packages</span>
            </div>
            {backups.length ? (
              <div className="backup-list">
                {backups.map((backup) => (
                  <label
                    className={`backup-row ${selectedId === backup.backupId ? "backup-row-selected" : ""}`}
                    key={backup.backupId}
                  >
                    <input
                      type="radio"
                      name="restore-backup"
                      checked={selectedId === backup.backupId}
                      onChange={() => {
                        setSelectedId(backup.backupId);
                        setConfirmName("");
                      }}
                    />
                    <span className="backup-row-main">
                      <strong>
                        {backup.store.name} · {purposeLabel(backup.purpose)}
                      </strong>
                      <small>
                        {formatTime(backup.createdAt)} · Business date{" "}
                        {backup.businessDate} · {backup.environment}
                      </small>
                    </span>
                    <span className="backup-copy-badges">
                      {backup.copies.map((copy) => (
                        <span
                          className={
                            copy.valid
                              ? "backup-copy-valid"
                              : "backup-copy-invalid"
                          }
                          key={copy.location}
                        >
                          {copy.location} {copy.valid ? "verified" : "failed"}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="table-loading">
                No backup packages are available.
              </div>
            )}
          </section>

          <section className="settings-main-card restore-card">
            <div className="card-heading">
              <div>
                <h2>Restore from backup</h2>
                <p>
                  Restoring replaces the current catalog, sales, shifts,
                  settings, and audit history. All staff sessions are revoked.
                </p>
              </div>
              <span className="activity-icon">
                <RotateCcw size={17} />
              </span>
            </div>
            {!selectedBackup ? (
              <p className="report-empty">
                Select a verified backup package above to review its store
                identity and restore date.
              </p>
            ) : (
              <form
                className="restore-form"
                onSubmit={(event) => void restore(event)}
              >
                <div className="restore-confirmation-card">
                  <strong>{selectedBackup.store.name}</strong>
                  <span>Created {formatTime(selectedBackup.createdAt)}</span>
                  <span>Backup store ID: {selectedBackup.store.id}</span>
                  <span>Package: {selectedBackup.backupId}</span>
                </div>
                <label className="inventory-field">
                  <span>Verified copy</span>
                  <select
                    className="text-input select-input"
                    value={copyLocation}
                    onChange={(event) =>
                      setCopyLocation(
                        event.target.value as "primary" | "secondary",
                      )
                    }
                  >
                    {restorableCopies.map((copy) => (
                      <option key={copy.location} value={copy.location}>
                        {copy.location} copy
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inventory-field">
                  <span>Type the store name above to confirm</span>
                  <input
                    className="text-input"
                    value={confirmName}
                    onChange={(event) => setConfirmName(event.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <label className="inventory-field">
                  <span>Current owner password</span>
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="current-password"
                    value={ownerPassword}
                    onChange={(event) => setOwnerPassword(event.target.value)}
                    required
                  />
                </label>
                <button
                  className="button button-danger"
                  disabled={busy || !restorableCopies.length}
                  type="submit"
                >
                  <RotateCcw size={16} /> Restore and sign out
                </button>
              </form>
            )}
            <p className="field-hint restore-safety-note">
              The server first creates and verifies a separate safety backup of
              the current database and customer data key. Restoration stops if
              the backup identity, checksums, encryption key, database
              integrity, or authorized owner account cannot be verified.
            </p>
          </section>
        </>
      )}
    </section>
  );
}
