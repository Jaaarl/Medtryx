import type Database from "better-sqlite3";
import {
  appConfigForCurrency,
  currencyCodeSchema,
  type CurrencyCode,
} from "@medtryx/shared";

const currencySettingKey = "currency";
const legacyFinancialTables = [
  "products",
  "stock_events",
  "stock_cost_corrections",
  "inventory_lots",
  "stock_receipts",
  "sales_bundles",
  "shifts",
  "sales",
  "sale_lines",
  "sale_bnpc_snapshots",
  "sale_reversals",
  "sale_payment_switches",
  "cash_movements",
  "expenses",
  "daily_sales_ledger",
  "daily_sales_journal",
  "bnpc_usage_events",
];

function configuredCurrency(): CurrencyCode | undefined {
  const configured = process.env.MEDTRYX_CURRENCY?.trim();
  if (!configured) return undefined;
  const parsed = currencyCodeSchema.safeParse(configured);
  if (!parsed.success) {
    throw new Error("MEDTRYX_CURRENCY must be PHP or USD.");
  }
  return parsed.data;
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function hasLegacyFinancialData(db: Database.Database): boolean {
  for (const table of legacyFinancialTables) {
    if (!hasTable(db, table)) continue;
    if (db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) return true;
  }
  if (hasTable(db, "bnpc_policy_versions")) {
    const configuredPolicy = db
      .prepare(
        `SELECT 1 FROM bnpc_policy_versions
         WHERE enabled = 1 OR approval_reference IS NOT NULL
         LIMIT 1`,
      )
      .get();
    if (configuredPolicy) return true;
  }
  if (!hasTable(db, "settings")) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM settings WHERE key = 'tax' LIMIT 1").get(),
  );
}

function storedCurrency(db: Database.Database): CurrencyCode | undefined {
  if (!hasTable(db, "settings")) return undefined;
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(currencySettingKey) as { value_json: string } | undefined;
  if (!row) return undefined;

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(row.value_json);
  } catch {
    throw new Error("The saved installation currency is invalid.");
  }
  const parsedCurrency = currencyCodeSchema.safeParse(parsedValue);
  if (!parsedCurrency.success) {
    throw new Error("The saved installation currency is invalid.");
  }
  return parsedCurrency.data;
}

function inferredCurrencyForMissingSetting(
  db: Database.Database,
  configured: CurrencyCode | undefined,
): CurrencyCode {
  if (hasLegacyFinancialData(db)) return "PHP";
  return configured ?? "PHP";
}

export function assertCurrencyCompatibleBeforeMigrations(
  db: Database.Database,
): void {
  const configured = configuredCurrency();
  const stored = storedCurrency(db);
  if (!configured) return;
  const databaseCurrency =
    stored ?? inferredCurrencyForMissingSetting(db, configured);
  if (configured !== databaseCurrency) {
    throw new Error(
      `MEDTRYX_CURRENCY=${configured} does not match the database currency ${databaseCurrency}. Currency is immutable for this installation.`,
    );
  }
}

export function initializeDatabaseCurrency(
  db: Database.Database,
): CurrencyCode {
  const configured = configuredCurrency();
  const initialize = db.transaction(() => {
    const stored = storedCurrency(db);
    if (stored) {
      if (configured && configured !== stored) {
        throw new Error(
          `MEDTRYX_CURRENCY=${configured} does not match the database currency ${stored}. Currency is immutable for this installation.`,
        );
      }
      return stored;
    }

    const currency = inferredCurrencyForMissingSetting(db, configured);
    if (configured && configured !== currency) {
      throw new Error(
        `MEDTRYX_CURRENCY=${configured} cannot be used because this database contains legacy PHP financial data.`,
      );
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, NULL)`,
    ).run(currencySettingKey, JSON.stringify(currency), now);
    return currency;
  });
  return initialize.immediate();
}

export function databaseCurrency(db: Database.Database): CurrencyCode {
  const stored = storedCurrency(db);
  return stored ?? inferredCurrencyForMissingSetting(db, configuredCurrency());
}

export function backupDatabaseCurrency(db: Database.Database): CurrencyCode {
  // A backup without the setting predates currency selection and is PHP.
  return storedCurrency(db) ?? "PHP";
}

export function writeRestoredCurrency(
  db: Database.Database,
  currency: CurrencyCode,
): void {
  const stored = storedCurrency(db);
  if (stored && stored !== currency) {
    throw new Error(
      "The restored database currency does not match its backup.",
    );
  }
  if (stored) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at, updated_by)
     VALUES (?, ?, ?, NULL)`,
  ).run(currencySettingKey, JSON.stringify(currency), now);
}

export function appConfig(db: Database.Database) {
  return appConfigForCurrency(databaseCurrency(db));
}
