import Database from "better-sqlite3";
import { createHash, randomUUID, randomUUID as uuid } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  customerEncryptionKeyHex,
  decryptCustomerFieldWithKey,
} from "./customer-data.js";
import {
  migrateDatabase,
  repositoryRoot,
  selectedEnvironment,
  writeAuditEvent,
} from "./db.js";
import { restrictDirectory, restrictFile } from "./secure-fs.js";
import { restoreIsActive, waitForMutationsToDrain } from "./maintenance.js";

const backupPurposeSchema = z.enum(["manual", "automatic", "safety"]);
const storeProfileSchema = z
  .object({ id: z.uuid(), name: z.string().trim().min(1).max(160) })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    backupId: z.uuid(),
    environment: z.enum(["development", "test", "live"]),
    purpose: backupPurposeSchema,
    createdAt: z.iso.datetime(),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    store: storeProfileSchema,
    databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    customerKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
    migrations: z.array(z.string().max(100)),
  })
  .strict();

type BackupPurpose = z.infer<typeof backupPurposeSchema>;
type StoreProfile = z.infer<typeof storeProfileSchema>;
type BackupManifest = z.infer<typeof manifestSchema>;
type BackupLocation = "primary" | "secondary";

export class BackupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function inside(base: string, candidate: string): boolean {
  const path = relative(resolve(base), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function manilaDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function configuredDirectory(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!isAbsolute(value))
    throw new BackupError("backup_paths_must_be_absolute");
  return resolve(value);
}

function backupRoots(): {
  primary: string;
  secondary: string;
  primaryBase: string;
  secondaryBase: string;
} {
  const primaryBase = configuredDirectory("MEDTRYX_BACKUP_PRIMARY_DIR");
  const secondaryBase = configuredDirectory("MEDTRYX_BACKUP_SECONDARY_DIR");
  if (!primaryBase || !secondaryBase)
    throw new BackupError("backup_paths_not_configured");
  const environment = selectedEnvironment();
  const primary = resolve(primaryBase, environment);
  const secondary = resolve(secondaryBase, environment);
  if (overlaps(primary, secondary))
    throw new BackupError("backup_locations_must_be_separate");
  if (
    inside(repositoryRoot, primaryBase) ||
    inside(primaryBase, repositoryRoot) ||
    inside(repositoryRoot, secondaryBase) ||
    inside(secondaryBase, repositoryRoot)
  )
    throw new BackupError("backup_paths_must_be_separate_from_repository");
  const dataDirectory = process.env.MEDTRYX_DATA_DIR;
  if (
    selectedEnvironment() === "live" &&
    dataDirectory &&
    (overlaps(dataDirectory, primaryBase) ||
      overlaps(dataDirectory, secondaryBase))
  ) {
    throw new BackupError("backup_paths_must_be_separate_from_database");
  }
  return { primary, secondary, primaryBase, secondaryBase };
}

function secureRoots(requireSeparateDevice: boolean): {
  primary: string;
  secondary: string;
  secondaryDeviceDifferent: boolean;
} {
  const { primary, secondary } = backupRoots();
  restrictDirectory(primary);
  restrictDirectory(secondary);
  const secondaryDeviceDifferent =
    statSync(primary).dev !== statSync(secondary).dev;
  if (requireSeparateDevice && !secondaryDeviceDifferent)
    throw new BackupError("secondary_backup_must_be_on_separate_storage");
  return { primary, secondary, secondaryDeviceDifferent };
}

export function storeProfile(db: Database.Database): StoreProfile | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'store_profile'")
    .get() as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = storeProfileSchema.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function configuredEncryptionKey(): string | null {
  try {
    return customerEncryptionKeyHex();
  } catch {
    return null;
  }
}

function validEncryptionKeyFileForLive(): void {
  if (selectedEnvironment() !== "live") return;
  const configured = process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE?.trim();
  if (!configured) throw new BackupError("live_customer_key_file_required");
  if (!isAbsolute(configured) || inside(repositoryRoot, configured))
    throw new BackupError(
      "customer_key_file_must_be_absolute_and_outside_repository",
    );
  try {
    restrictFile(configured);
  } catch {
    throw new BackupError("customer_key_file_permissions_failed");
  }
  if (!configuredEncryptionKey())
    throw new BackupError("customer_encryption_key_not_configured");
}

export function backupStatus(db: Database.Database) {
  let primary = false;
  let secondary = false;
  let secondaryDeviceDifferent = false;
  try {
    const roots = backupRoots();
    primary = existsSync(roots.primaryBase);
    secondary = existsSync(roots.secondaryBase);
    if (primary && secondary)
      secondaryDeviceDifferent =
        statSync(roots.primaryBase).dev !== statSync(roots.secondaryBase).dev;
  } catch {
    // The detailed path configuration stays on the server.
  }
  const keyConfigured = configuredEncryptionKey() !== null;
  const profile = storeProfile(db);
  const separate =
    selectedEnvironment() === "live"
      ? secondaryDeviceDifferent
      : primary && secondary;
  return {
    environment: selectedEnvironment(),
    storeConfigured: profile !== null,
    store: profile ? { id: profile.id, name: profile.name } : null,
    customerEncryptionKeyConfigured: keyConfigured,
    primaryDirectoryReady: primary,
    secondaryDirectoryReady: secondary,
    secondaryOnSeparateDevice: secondaryDeviceDifferent,
    ready: Boolean(
      profile && keyConfigured && primary && secondary && separate,
    ),
  };
}

export function assertLiveBackupConfiguration(): void {
  if (selectedEnvironment() !== "live") return;
  validEncryptionKeyFileForLive();
  secureRoots(true);
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function safeUnlinkTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function restrictTree(path: string): void {
  restrictDirectory(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) restrictTree(child);
    else restrictFile(child);
  }
}

function migrationNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const result = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  if (result.length !== 1 || result[0]?.integrity_check !== "ok")
    throw new BackupError("backup_database_integrity_failed");
  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0)
    throw new BackupError("backup_database_foreign_key_failed");
}

function validateCustomerCiphertexts(db: Database.Database, key: string): void {
  const rows = db
    .prepare(
      `SELECT id, customer_name_ciphertext, customer_id_type_ciphertext,
              customer_id_number_ciphertext
       FROM sales WHERE customer_name_ciphertext IS NOT NULL
          OR customer_id_type_ciphertext IS NOT NULL
          OR customer_id_number_ciphertext IS NOT NULL`,
    )
    .all() as {
    id: string;
    customer_name_ciphertext: string | null;
    customer_id_type_ciphertext: string | null;
    customer_id_number_ciphertext: string | null;
  }[];
  try {
    for (const row of rows) {
      if (
        !row.customer_name_ciphertext ||
        !row.customer_id_type_ciphertext ||
        !row.customer_id_number_ciphertext
      ) {
        throw new Error("missing_encrypted_customer_field");
      }
      decryptCustomerFieldWithKey(
        row.customer_name_ciphertext,
        `${row.id}/name`,
        key,
      );
      decryptCustomerFieldWithKey(
        row.customer_id_type_ciphertext,
        `${row.id}/id-type`,
        key,
      );
      decryptCustomerFieldWithKey(
        row.customer_id_number_ciphertext,
        `${row.id}/id-number`,
        key,
      );
    }
  } catch {
    throw new BackupError("backup_customer_records_cannot_be_decrypted");
  }
}

export type BackupSummary = {
  backupId: string;
  environment: string;
  purpose: BackupPurpose;
  createdAt: string;
  businessDate: string;
  store: StoreProfile;
  copies: Array<{ location: BackupLocation; valid: boolean; error?: string }>;
};

type VerifiedPackage = {
  path: string;
  manifest: BackupManifest;
  key: string;
};

function readManifest(packagePath: string): BackupManifest {
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(readFileSync(resolve(packagePath, "manifest.json"), "utf8")),
    );
    if (!parsed.success) throw new Error("invalid_manifest");
    return parsed.data;
  } catch {
    throw new BackupError("backup_manifest_invalid");
  }
}

function resolvePackagePath(
  location: BackupLocation,
  backupId: string,
): string {
  if (!z.uuid().safeParse(backupId).success)
    throw new BackupError("backup_not_found");
  const roots = backupRoots();
  const root = roots[location];
  const packagePath = resolve(root, backupId);
  if (!inside(root, packagePath) || packagePath === root)
    throw new BackupError("backup_not_found");
  return packagePath;
}

async function verifyPackage(
  location: BackupLocation,
  backupId: string,
): Promise<VerifiedPackage> {
  try {
    return await verifyPackageContents(location, backupId);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup_verification_failed");
  }
}

async function verifyPackageContents(
  location: BackupLocation,
  backupId: string,
): Promise<VerifiedPackage> {
  const packagePath = resolvePackagePath(location, backupId);
  if (!existsSync(packagePath)) throw new BackupError("backup_not_found");
  const manifest = readManifest(packagePath);
  if (manifest.backupId !== backupId)
    throw new BackupError("backup_manifest_identity_mismatch");
  const databasePath = resolve(packagePath, "store.sqlite");
  const keyPath = resolve(packagePath, "customer-id-encryption-key.txt");
  const databaseHash = await sha256File(databasePath);
  const key = readFileSync(keyPath, "utf8").trim().toLowerCase();
  if (databaseHash !== manifest.databaseSha256)
    throw new BackupError("backup_database_checksum_failed");
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new BackupError("backup_customer_key_invalid");
  if (
    createHash("sha256").update(key, "utf8").digest("hex") !==
    manifest.customerKeySha256
  )
    throw new BackupError("backup_customer_key_checksum_failed");
  const snapshot = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assertDatabaseIntegrity(snapshot);
    if (
      JSON.stringify(migrationNames(snapshot)) !==
      JSON.stringify(manifest.migrations)
    )
      throw new BackupError("backup_migration_manifest_mismatch");
    const snapshotProfile = storeProfile(snapshot);
    if (
      !snapshotProfile ||
      snapshotProfile.id !== manifest.store.id ||
      snapshotProfile.name !== manifest.store.name
    )
      throw new BackupError("backup_store_identity_mismatch");
    validateCustomerCiphertexts(snapshot, key);
  } finally {
    snapshot.close();
  }
  return { path: packagePath, manifest, key };
}

export async function listBackups(): Promise<BackupSummary[]> {
  const roots = backupRoots();
  const byId = new Map<string, BackupSummary>();
  for (const location of ["primary", "secondary"] as const) {
    const root = roots[location];
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success)
        continue;
      const packagePath = resolve(root, entry.name);
      let summary = byId.get(entry.name);
      try {
        const manifest = readManifest(packagePath);
        summary ??= {
          backupId: manifest.backupId,
          environment: manifest.environment,
          purpose: manifest.purpose,
          createdAt: manifest.createdAt,
          businessDate: manifest.businessDate,
          store: manifest.store,
          copies: [],
        };
        await verifyPackage(location, entry.name);
        summary.copies.push({ location, valid: true });
      } catch {
        summary ??= {
          backupId: entry.name,
          environment: selectedEnvironment(),
          purpose: "manual",
          createdAt: "",
          businessDate: "",
          store: {
            id: "00000000-0000-4000-8000-000000000000",
            name: "Unknown store",
          },
          copies: [],
        };
        summary.copies.push({
          location,
          valid: false,
          error: "Backup verification failed.",
        });
      }
      byId.set(entry.name, summary);
    }
  }
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function createBackup(
  db: Database.Database,
  purpose: BackupPurpose,
  actorUserId: string | null,
): Promise<BackupSummary> {
  const profile = storeProfile(db);
  if (!profile) throw new BackupError("store_profile_required");
  const key = configuredEncryptionKey();
  if (!key) throw new BackupError("customer_encryption_key_not_configured");
  validEncryptionKeyFileForLive();
  const { primary, secondary, secondaryDeviceDifferent } = secureRoots(
    selectedEnvironment() === "live",
  );
  const backupId = randomUUID();
  const createdAt = new Date().toISOString();
  const primaryTemp = resolve(primary, `.tmp-${backupId}`);
  const secondaryTemp = resolve(secondary, `.tmp-${backupId}`);
  const primaryFinal = resolve(primary, backupId);
  const secondaryFinal = resolve(secondary, backupId);
  try {
    restrictDirectory(primaryTemp);
    const databasePath = resolve(primaryTemp, "store.sqlite");
    await db.backup(databasePath);
    const snapshot = new Database(databasePath);
    try {
      snapshot.pragma("foreign_keys = ON");
      snapshot.prepare("DELETE FROM sessions").run();
      assertDatabaseIntegrity(snapshot);
      validateCustomerCiphertexts(snapshot, key);
    } finally {
      snapshot.close();
    }
    const keyPath = resolve(primaryTemp, "customer-id-encryption-key.txt");
    writeFileSync(keyPath, `${key}\n`, { mode: 0o600, flag: "wx" });
    restrictFile(keyPath);
    const readOnlySnapshot = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    let migrations: string[];
    try {
      migrations = migrationNames(readOnlySnapshot);
    } finally {
      readOnlySnapshot.close();
    }
    const manifest: BackupManifest = {
      formatVersion: 1,
      backupId,
      environment: selectedEnvironment(),
      purpose,
      createdAt,
      businessDate: manilaDate(new Date(createdAt)),
      store: profile,
      databaseSha256: await sha256File(databasePath),
      customerKeySha256: createHash("sha256").update(key, "utf8").digest("hex"),
      migrations,
    };
    const manifestPath = resolve(primaryTemp, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    restrictTree(primaryTemp);
    cpSync(primaryTemp, secondaryTemp, { recursive: true, errorOnExist: true });
    restrictTree(secondaryTemp);
    renameSync(primaryTemp, primaryFinal);
    renameSync(secondaryTemp, secondaryFinal);
    await verifyPackage("primary", backupId);
    await verifyPackage("secondary", backupId);
    writeAuditEvent(db, {
      actorUserId,
      action: "backup.created",
      entityType: "backup",
      entityId: backupId,
      details: { purpose, secondaryDeviceDifferent },
    });
    return {
      backupId,
      environment: manifest.environment,
      purpose,
      createdAt,
      businessDate: manifest.businessDate,
      store: profile,
      copies: [
        { location: "primary", valid: true },
        { location: "secondary", valid: true },
      ],
    };
  } catch (error) {
    safeUnlinkTree(primaryTemp);
    safeUnlinkTree(secondaryTemp);
    safeUnlinkTree(primaryFinal);
    safeUnlinkTree(secondaryFinal);
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup_creation_failed");
  }
}

function setCustomerKeyForRestore(key: string): {
  rollback: () => void;
  complete: () => void;
} {
  const keyFile = process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE?.trim();
  if (!keyFile) {
    if (customerEncryptionKeyHex() !== key)
      throw new BackupError("configure_customer_key_file_before_restore");
    return { rollback: () => undefined, complete: () => undefined };
  }
  if (!isAbsolute(keyFile))
    throw new BackupError("customer_key_file_path_must_be_absolute");
  const path = resolve(keyFile);
  if (!existsSync(dirname(path)))
    throw new BackupError("customer_key_directory_missing");
  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const writeKeyAtomically = (contents: string) => {
    const temporaryDirectory = resolve(dirname(path), `.medtryx-key-${uuid()}`);
    try {
      restrictDirectory(temporaryDirectory);
      const temporary = resolve(temporaryDirectory, "customer-data.key");
      writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
      restrictFile(temporary);
      renameSync(temporary, path);
      restrictFile(path);
    } finally {
      safeUnlinkTree(temporaryDirectory);
    }
  };
  writeKeyAtomically(`${key}\n`);
  return {
    rollback: () => {
      if (original === null) rmSync(path, { force: true });
      else writeKeyAtomically(original);
    },
    complete: () => undefined,
  };
}

const restoreTables = [
  "schema_migrations",
  "users",
  "settings",
  "product_sku_sequence",
  "products",
  "sale_sequences",
  "reversal_sequences",
  "stock_events",
  "shifts",
  "sales",
  "sale_lines",
  "sale_reversals",
  "sale_reversal_lines",
  "cash_movements",
  "audit_events",
] as const;

function applyRestoredDatabase(
  db: Database.Database,
  sourcePath: string,
  actorUserId: string,
  actorEmail: string,
  backupId: string,
): void {
  db.prepare("ATTACH DATABASE ? AS restore_source").run(sourcePath);
  try {
    db.pragma("foreign_keys = OFF");
    const restoreTransaction = db.transaction(() => {
      for (const table of [...restoreTables].reverse())
        db.exec(`DELETE FROM main.${table}`);
      for (const table of restoreTables) {
        const tableInfo = db.pragma(`main.table_info(${table})`) as Array<{
          name: string;
        }>;
        const columns = tableInfo.map((column) => column.name);
        if (!columns.length) throw new BackupError("restore_schema_mismatch");
        const columnList = columns.map((column) => `"${column}"`).join(", ");
        db.exec(
          `INSERT INTO main.${table} (${columnList}) SELECT ${columnList} FROM restore_source.${table}`,
        );
      }
      db.prepare("DELETE FROM main.sessions").run();
      const activeActor = db
        .prepare("SELECT id FROM main.users WHERE id = ? AND is_active = 1")
        .get(actorUserId) as { id: string } | undefined;
      writeAuditEvent(db, {
        actorUserId: activeActor?.id ?? null,
        action: "backup.restored",
        entityType: "backup",
        entityId: backupId,
        details: { reauthenticatedActorEmail: actorEmail },
      });
      const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
      if (foreignKeyErrors.length)
        throw new BackupError("restore_foreign_key_failed");
      assertDatabaseIntegrity(db);
    });
    restoreTransaction();
  } finally {
    db.pragma("foreign_keys = ON");
    db.prepare("DETACH DATABASE restore_source").run();
  }
}

export async function restoreBackup(
  db: Database.Database,
  input: {
    backupId: string;
    location: BackupLocation;
    confirmStoreId: string;
    actorUserId: string;
    actorEmail: string;
  },
): Promise<{ backup: BackupSummary; safetyBackupId: string }> {
  await waitForMutationsToDrain();
  const backup = await verifyPackage(input.location, input.backupId);
  if (backup.manifest.environment !== selectedEnvironment())
    throw new BackupError("backup_environment_mismatch");
  if (backup.manifest.store.id !== input.confirmStoreId)
    throw new BackupError("restore_store_confirmation_mismatch");

  const stageDirectory = resolve(dirname(db.name), `.restore-${randomUUID()}`);
  restrictDirectory(stageDirectory);
  const stagedDatabasePath = resolve(stageDirectory, "restored.sqlite");
  let keyChange: ReturnType<typeof setCustomerKeyForRestore> | undefined;
  try {
    copyFileSync(resolve(backup.path, "store.sqlite"), stagedDatabasePath);
    restrictFile(stagedDatabasePath);
    const staged = new Database(stagedDatabasePath);
    try {
      migrateDatabase(staged);
      staged.pragma("foreign_keys = ON");
      assertDatabaseIntegrity(staged);
      validateCustomerCiphertexts(staged, backup.key);
      const owners = staged
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND is_active = 1",
        )
        .get() as { count: number };
      if (owners.count < 1)
        throw new BackupError("restore_has_no_active_owner");
      const restoredProfileRow = staged
        .prepare("SELECT value_json FROM settings WHERE key = 'store_profile'")
        .get() as { value_json: string } | undefined;
      if (!restoredProfileRow)
        throw new BackupError("restore_store_profile_missing");
      const restoredProfile = storeProfileSchema.safeParse(
        JSON.parse(restoredProfileRow.value_json),
      );
      if (
        !restoredProfile.success ||
        restoredProfile.data.id !== backup.manifest.store.id
      )
        throw new BackupError("restore_store_identity_mismatch");
      if (
        JSON.stringify(migrationNames(staged)) !==
        JSON.stringify(migrationNames(db))
      )
        throw new BackupError("restore_schema_incompatible");
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError("restore_validation_failed");
    } finally {
      staged.close();
    }

    const safety = await createBackup(db, "safety", input.actorUserId);
    keyChange = setCustomerKeyForRestore(backup.key);
    applyRestoredDatabase(
      db,
      stagedDatabasePath,
      input.actorUserId,
      input.actorEmail,
      input.backupId,
    );
    keyChange.complete();
    return {
      backup: {
        backupId: backup.manifest.backupId,
        environment: backup.manifest.environment,
        purpose: backup.manifest.purpose,
        createdAt: backup.manifest.createdAt,
        businessDate: backup.manifest.businessDate,
        store: backup.manifest.store,
        copies: [{ location: input.location, valid: true }],
      },
      safetyBackupId: safety.backupId,
    };
  } catch (error) {
    keyChange?.rollback();
    if (error instanceof BackupError) throw error;
    throw new BackupError("restore_failed");
  } finally {
    safeUnlinkTree(stageDirectory);
  }
}

export async function createAutomaticBackupIfDue(
  db: Database.Database,
): Promise<void> {
  if (restoreIsActive() || !storeProfile(db)) return;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  if (`${values.hour}:${values.minute}` < "02:00") return;
  const day = manilaDate(now);
  const { primary, secondary } = backupRoots();
  for (const root of [primary, secondary]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success)
        continue;
      try {
        const manifest = readManifest(resolve(root, entry.name));
        if (manifest.purpose === "automatic" && manifest.businessDate === day)
          return;
      } catch {
        // Damaged packages do not count as a completed daily backup.
      }
    }
  }
  await createBackup(db, "automatic", null);
}
