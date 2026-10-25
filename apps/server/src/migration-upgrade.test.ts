import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase, openDatabase } from "./db.js";
import {
  applyMigrationsThrough,
  insertMigrationFixture,
  seedProductionMigrationRecords,
  snapshotMigrationTables,
} from "./test-migrations.js";

const migrationName = "0027_payments_and_expenses.sql";
const startupCases = (["development", "test", "live"] as const).flatMap(
  (environment) =>
    [0, 10000, null].map((expectedCash) => ({ environment, expectedCash })),
);
function expectHealthy(db: Database.Database) {
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
}
const schemaRows = (db: Database.Database) =>
  db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
const appliedRows = (db: Database.Database) =>
  db.prepare("SELECT * FROM schema_migrations ORDER BY name").all();

describe("single payments migration from the committed 0026 schema", () => {
  it.each(startupCases)(
    "preserves every existing row and index on $environment startup (expected cash $expectedCash)",
    ({ environment, expectedCash }) => {
      const directory = mkdtempSync(join(tmpdir(), "medtryx-upgrade-0026-"));
      // Even live mode uses a private synthetic database outside the repository.
      vi.stubEnv("MEDTRYX_DATA_DIR", directory);
      let db = new Database(join(directory, `${environment}.sqlite`));
      try {
        db.pragma("journal_mode = WAL");
        applyMigrationsThrough(db, 26);
        seedProductionMigrationRecords(db, expectedCash);
        expectHealthy(db);
        const original = snapshotMigrationTables(db);
        const originalMigrations = appliedRows(db);
        const indexes = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
          )
          .all();
        const originalOtherSchema = db
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ('shifts', 'expenses', 'products', 'expense_cancellations', 'monthly_incentive_months') AND name <> 'sale_lines_no_deleted_product' ORDER BY type, name",
          )
          .all();
        db.close();
        db = openDatabase(environment, directory);
        expect(snapshotMigrationTables(db, original)).toEqual(original);
        expect(appliedRows(db).slice(0, 26)).toEqual(originalMigrations);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
            )
            .all(),
        ).toEqual(expect.arrayContaining(indexes));
        expect(
          db
            .prepare(
              "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ('shifts', 'expenses', 'products', 'expense_cancellations', 'monthly_incentive_months') AND name <> 'sale_lines_no_deleted_product' ORDER BY type, name",
            )
            .all(),
        ).toEqual(originalOtherSchema);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM expenses").get(),
        ).toEqual({ count: 0 });
        const applied = appliedRows(db);
        expect(applied).toHaveLength(31);
        expect(applied[30]).toMatchObject({
          name: "0031_expense_cancellations.sql",
        });
        expect(applied[29]).toMatchObject({
          name: "0030_monthly_incentive_goals.sql",
        });
        expect(applied[28]).toMatchObject({
          name: "0029_signed_shift_cash_counts.sql",
        });
        expect(applied[27]).toMatchObject({
          name: "0028_product_soft_delete.sql",
        });
        expect(applied[26]).toMatchObject({ name: migrationName });
        expectHealthy(db);
        const upgraded = snapshotMigrationTables(db);
        db.close();
        db = openDatabase(environment, directory);
        expect(snapshotMigrationTables(db)).toEqual(upgraded);
        expect(appliedRows(db)).toEqual(applied);
        expectHealthy(db);
      } finally {
        if (db.open) db.close();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("installs the complete COD ledger and preserves drawer and ledger constraints", () => {
    const db = new Database(":memory:");
    try {
      applyMigrationsThrough(db, 26);
      seedProductionMigrationRecords(db);
      migrateDatabase(db);
      const stockPayment = {
        id: "new-stock-payment",
        request_id: "new-stock-request",
        business_date: "2026-10-01",
        category: "STOCK_PURCHASE",
        amount_centavos: 1520000,
        product_amount_centavos: 1500000,
        delivery_fee_centavos: 20000,
        description: "Synthetic COD invoice",
        payment_source: "OWNER",
        included_in_unit_cost: 0,
        supplier: "Synthetic supplier",
        invoice_reference: "SYN-COD-001",
        recorded_by_user_id: "upgrade-owner",
        created_at: "2026-10-01T12:00:00.000Z",
      };
      insertMigrationFixture(db, "expenses", stockPayment);
      expect(() =>
        insertMigrationFixture(db, "expenses", {
          ...stockPayment,
          id: "wrong-total",
          request_id: "wrong-total",
          amount_centavos: 1500000,
        }),
      ).toThrow();
      expect(() =>
        insertMigrationFixture(db, "expenses", {
          ...stockPayment,
          id: "wrong-classification",
          request_id: "wrong-classification",
          included_in_unit_cost: 1,
        }),
      ).toThrow();
      expect(() =>
        insertMigrationFixture(db, "expenses", {
          ...stockPayment,
          id: "missing-user",
          request_id: "missing-user",
          recorded_by_user_id: "missing-user",
        }),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        insertMigrationFixture(db, "expenses", {
          ...stockPayment,
          id: "reused-request",
        }),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.prepare("UPDATE expenses SET amount_centavos = 1").run(),
      ).toThrow("expenses_are_append_only");
      expect(() => db.prepare("DELETE FROM expenses").run()).toThrow(
        "expenses_are_append_only",
      );
      expect(() =>
        db
          .prepare(
            "UPDATE shifts SET expected_cash_centavos = -1500000 WHERE id = 'upgrade-open'",
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        insertMigrationFixture(db, "shifts", {
          id: "second-open",
          cashier_user_id: "upgrade-owner",
          opened_at: "2026-10-01T12:00:00.000Z",
          opening_cash_centavos: 0,
        }),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "UPDATE shifts SET opening_cash_centavos = -1 WHERE id = 'upgrade-open'",
          )
          .run(),
      ).toThrow();
      const original = snapshotMigrationTables(db);
      migrateDatabase(db);
      expect(snapshotMigrationTables(db)).toEqual(original);
      expect(() =>
        db
          .prepare(
            `UPDATE shifts
             SET actual_cash_count_centavos = -1,
                 variance_centavos = -1 - expected_cash_centavos,
                 variance_reason = 'Negative count supported'
             WHERE id = 'upgrade-closed-APPROVED'`,
          )
          .run(),
      ).not.toThrow();
      expect(
        db
          .prepare(
            "SELECT actual_cash_count_centavos FROM shifts WHERE id = 'upgrade-closed-APPROVED'",
          )
          .get(),
      ).toEqual({ actual_cash_count_centavos: -1 });
      expectHealthy(db);
    } finally {
      db.close();
    }
  });

  it.each(["after shifts rebuild", "after complete migration"] as const)(
    "rolls back the entire 0027 migration on failure %s and retries safely",
    (failurePoint) => {
      const db = new Database(":memory:");
      try {
        applyMigrationsThrough(db, 26);
        seedProductionMigrationRecords(db);
        const original = snapshotMigrationTables(db);
        const schema = schemaRows(db);
        const applied = appliedRows(db);
        const execute = db.exec.bind(db);
        const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql.includes("CREATE TABLE shifts_rebuilt")) {
            execute(
              failurePoint === "after shifts rebuild"
                ? sql.slice(0, sql.indexOf("CREATE TABLE expenses ("))
                : sql,
            );
            throw new Error("synthetic migration failure");
          }
          return execute(sql);
        });
        try {
          expect(() => migrateDatabase(db)).toThrow(
            "synthetic migration failure",
          );
        } finally {
          spy.mockRestore();
        }
        expect(snapshotMigrationTables(db)).toEqual(original);
        expect(schemaRows(db)).toEqual(schema);
        expect(appliedRows(db)).toEqual(applied);
        expectHealthy(db);
        migrateDatabase(db);
        expect(snapshotMigrationTables(db, original)).toEqual(original);
        expect(
          db
            .prepare("SELECT name FROM schema_migrations WHERE name = ?")
            .get(migrationName),
        ).toEqual({ name: migrationName });
        expectHealthy(db);
      } finally {
        db.close();
      }
    },
  );

  it("leaves the original schema and records intact if a conflicting expenses table exists", () => {
    const db = new Database(":memory:");
    try {
      applyMigrationsThrough(db, 26);
      seedProductionMigrationRecords(db);
      db.exec(
        "CREATE TABLE expenses (id TEXT PRIMARY KEY); INSERT INTO expenses VALUES ('unrelated-existing-record');",
      );
      const original = snapshotMigrationTables(db);
      const schema = schemaRows(db);
      expect(() => migrateDatabase(db)).toThrow(/expenses already exists/);
      expect(snapshotMigrationTables(db)).toEqual(original);
      expect(schemaRows(db)).toEqual(schema);
      expect(appliedRows(db)).toHaveLength(26);
      expectHealthy(db);
    } finally {
      db.close();
    }
  });
});
