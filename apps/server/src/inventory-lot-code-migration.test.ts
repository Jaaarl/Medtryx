import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./db.js";
import { lotLedgerIssues } from "./lot-stock.js";
import {
  applyMigrationsThrough,
  seedProductionMigrationRecords,
  snapshotMigrationTables,
} from "./test-migrations.js";

describe("0032 editable inventory lot code migration", () => {
  it("allows audited batch code corrections and preserves other lot protections", () => {
    const db = new Database(":memory:");
    try {
      applyMigrationsThrough(db, 31);
      seedProductionMigrationRecords(db);

      expect(() =>
        db
          .prepare("UPDATE inventory_lots SET lot_code = ? WHERE id = ?")
          .run("SYN-UPGRADE-LOT-CORRECTED", "upgrade-lot"),
      ).toThrow(/inventory_lot_identity_is_immutable/u);

      const beforeMigration = snapshotMigrationTables(db);
      migrateDatabase(db);
      expect(snapshotMigrationTables(db, beforeMigration)).toEqual(
        beforeMigration,
      );

      db.prepare("UPDATE inventory_lots SET lot_code = ? WHERE id = ?").run(
        "SYN-UPGRADE-LOT-CORRECTED",
        "upgrade-lot",
      );
      expect(
        db
          .prepare("SELECT lot_code FROM inventory_lots WHERE id = ?")
          .get("upgrade-lot"),
      ).toEqual({ lot_code: "SYN-UPGRADE-LOT-CORRECTED" });
      expect(() =>
        db
          .prepare("UPDATE inventory_lots SET product_id = ? WHERE id = ?")
          .run("another-product", "upgrade-lot"),
      ).toThrow(/inventory_lot_identity_is_immutable/u);
      expect(() =>
        db
          .prepare("DELETE FROM inventory_lots WHERE id = ?")
          .run("upgrade-lot"),
      ).toThrow(/inventory_lots_are_immutable/u);
      expect(lotLedgerIssues(db)).toEqual([]);

      const upgraded = snapshotMigrationTables(db);
      migrateDatabase(db);
      expect(snapshotMigrationTables(db)).toEqual(upgraded);
    } finally {
      db.close();
    }
  });
});
