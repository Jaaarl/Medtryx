import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "./db.js";
import { lotLedgerIssues } from "./lot-stock.js";
import {
  applyMigrationsThrough,
  seedProductionMigrationRecords,
  snapshotMigrationTables,
} from "./test-migrations.js";

describe("0028 product soft-delete migration", () => {
  it("preserves all populated 0027 records and remains safe on repeated startup", () => {
    const db = new Database(":memory:");
    try {
      applyMigrationsThrough(db, 27);
      seedProductionMigrationRecords(db);
      const original = snapshotMigrationTables(db);
      const applied = db
        .prepare("SELECT * FROM schema_migrations ORDER BY name")
        .all();
      migrateDatabase(db);
      expect(snapshotMigrationTables(db, original)).toEqual(original);
      expect(
        db
          .prepare("SELECT * FROM schema_migrations ORDER BY name")
          .all()
          .slice(0, 27),
      ).toEqual(applied);
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM products WHERE deleted_at IS NOT NULL",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(lotLedgerIssues(db)).toEqual([]);
      const upgraded = snapshotMigrationTables(db);
      const migrations = db
        .prepare("SELECT * FROM schema_migrations ORDER BY name")
        .all();
      migrateDatabase(db);
      expect(snapshotMigrationTables(db)).toEqual(upgraded);
      expect(
        db.prepare("SELECT * FROM schema_migrations ORDER BY name").all(),
      ).toEqual(migrations);
    } finally {
      db.close();
    }
  });

  it("rolls back schema, indexes, triggers, and records on migration failure and retries safely", () => {
    const db = new Database(":memory:");
    try {
      applyMigrationsThrough(db, 27);
      seedProductionMigrationRecords(db);
      const original = snapshotMigrationTables(db);
      const schema = db
        .prepare("SELECT * FROM sqlite_master ORDER BY type, name")
        .all();
      const execute = db.exec.bind(db);
      const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql.includes("ALTER TABLE products ADD COLUMN deleted_at")) {
          execute(sql);
          throw new Error("synthetic soft-delete migration failure");
        }
        return execute(sql);
      });
      expect(() => migrateDatabase(db)).toThrow(
        "synthetic soft-delete migration failure",
      );
      spy.mockRestore();
      expect(snapshotMigrationTables(db)).toEqual(original);
      expect(
        db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(schema);
      expect(
        db.prepare("SELECT count(*) AS count FROM schema_migrations").get(),
      ).toEqual({ count: 27 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      migrateDatabase(db);
      expect(snapshotMigrationTables(db, original)).toEqual(original);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
