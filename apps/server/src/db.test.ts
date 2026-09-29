import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateDatabase, repositoryRoot } from "./db.js";

describe("database migrations", () => {
  it("upgrades populated stock into unallocated legacy balances without inventing lots", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationsDirectory = resolve(
        repositoryRoot,
        "database/migrations",
      );
      for (const name of readdirSync(migrationsDirectory)
        .filter((entry) => /^000[1-9]_.*\.sql$/u.test(entry))
        .sort()) {
        db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        db.prepare(
          "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        ).run(name, new Date().toISOString());
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users
          (id, email, password_hash, role, is_active, created_at, updated_at)
         VALUES ('legacy-owner', 'legacy-owner@example.test', 'synthetic-hash', 'owner', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO products
          (id, sku, name, unit, selling_price_centavos, tax_class,
           sc_pwd_eligible, sc_eligible, pwd_eligible, product_type,
           quantity_on_hand, inventory_value_centavos, is_active, created_at, updated_at)
         VALUES ('legacy-product', 'SYN-LEGACY-LOT', 'Legacy tracked later', 'piece',
           500, 'VATABLE', 0, 0, 0, NULL, 4, 700, 1, ?, ?)`,
      ).run(now, now);
      for (const [eventId, eventType, qty, value, cost] of [
        ["legacy-opening", "OPENING", 5, 1_000, 200],
        ["legacy-sale", "SALE", -1, -300, 300],
      ] as const) {
        db.prepare(
          `INSERT INTO stock_events
            (id, product_id, event_type, quantity_delta, unit_cost_centavos,
             inventory_value_delta_centavos, actor_user_id, created_at)
           VALUES (?, 'legacy-product', ?, ?, ?, ?, 'legacy-owner', ?)`,
        ).run(eventId, eventType, qty, cost, value, now);
      }

      migrateDatabase(db);

      expect(
        db
          .prepare(
            "SELECT quantity_on_hand, inventory_value_centavos, tracks_lots FROM products WHERE id = 'legacy-product'",
          )
          .get(),
      ).toEqual({
        quantity_on_hand: 4,
        inventory_value_centavos: 700,
        tracks_lots: 0,
      });
      expect(
        db
          .prepare(
            `SELECT sum(quantity_delta) AS quantity,
                    sum(inventory_value_delta_centavos) AS value
             FROM lot_stock_movements WHERE product_id = 'legacy-product' AND lot_id IS NULL`,
          )
          .get(),
      ).toEqual({ quantity: 4, value: 700 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM inventory_lots").get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM stock_events WHERE product_id = 'legacy-product'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("stops the lot migration without schema changes when the old stock ledger disagrees", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationsDirectory = resolve(
        repositoryRoot,
        "database/migrations",
      );
      for (const name of readdirSync(migrationsDirectory)
        .filter((entry) => /^000[1-9]_.*\.sql$/u.test(entry))
        .sort()) {
        db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        db.prepare(
          "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        ).run(name, new Date().toISOString());
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users
          (id, email, password_hash, role, is_active, created_at, updated_at)
         VALUES ('legacy-owner', 'legacy-owner@example.test', 'synthetic-hash', 'owner', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO products
          (id, sku, name, unit, selling_price_centavos, tax_class,
           sc_pwd_eligible, sc_eligible, pwd_eligible, product_type,
           quantity_on_hand, inventory_value_centavos, is_active, created_at, updated_at)
         VALUES ('legacy-mismatch', 'SYN-LEDGER-MISMATCH', 'Legacy mismatch', 'piece',
           500, 'VATABLE', 0, 0, 0, NULL, 4, 700, 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO stock_events
          (id, product_id, event_type, quantity_delta, unit_cost_centavos,
           inventory_value_delta_centavos, actor_user_id, created_at)
         VALUES ('legacy-mismatch-event', 'legacy-mismatch', 'OPENING', 3, 200, 600, 'legacy-owner', ?)`,
      ).run(now);

      expect(() => migrateDatabase(db)).toThrow(
        /lot_expiry_requires_reconciled_stock/u,
      );
      expect(
        db
          .prepare(
            "SELECT name FROM schema_migrations WHERE name LIKE '0010_%'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = 'legacy-mismatch'",
          )
          .get(),
      ).toEqual({ quantity_on_hand: 4, inventory_value_centavos: 700 });
      expect(
        (db.pragma("table_info(products)") as Array<{ name: string }>).some(
          (column) => column.name === "tracks_lots",
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("preserves legacy sale totals and defaults their rounding snapshots to none", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationsDirectory = resolve(
        repositoryRoot,
        "database/migrations",
      );
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => /^000[1-8]_.*\.sql$/u.test(name))
        .sort();
      for (const name of priorMigrations) {
        db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        db.prepare(
          "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        ).run(name, new Date().toISOString());
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users
           (id, email, password_hash, role, is_active, created_at, updated_at)
         VALUES ('legacy-cashier', 'legacy@example.test', 'synthetic-hash', 'cashier', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO shifts
          (id, cashier_user_id, opened_at, opening_cash_centavos,
           expected_cash_centavos)
         VALUES ('legacy-shift', 'legacy-cashier', ?, 0, 100)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sales
          (id, transaction_id, business_date, request_key, request_hash,
           cashier_user_id, shift_id, benefit_type, customer_id_checked,
           payment_method, subtotal_centavos, vat_centavos,
           vat_removed_centavos, senior_discount_centavos,
           pwd_discount_centavos, amount_due_centavos, tax_policy_version,
           created_at)
         VALUES ('legacy-sale', 'MTX-20260102-000001', '2026-01-02',
           'legacy-key', 'legacy-hash', 'legacy-cashier', 'legacy-shift',
           'REGULAR', 0, 'CASH', 100, 0, 0, 0, 0, 100, 'LEGACY', ?)`,
      ).run(now);

      migrateDatabase(db);

      expect(
        db
          .prepare(
            `SELECT amount_due_centavos, cash_rounding_mode,
                    cash_rounding_adjustment_centavos FROM sales
             WHERE id = 'legacy-sale'`,
          )
          .get(),
      ).toEqual({
        amount_due_centavos: 100,
        cash_rounding_mode: "NONE",
        cash_rounding_adjustment_centavos: 0,
      });
    } finally {
      db.close();
    }
  });

  it("preserves legacy combined SC/PWD eligibility as eligibility for both", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationsDirectory = resolve(
        repositoryRoot,
        "database/migrations",
      );
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => /^000[1-5]_.*\.sql$/u.test(name))
        .sort();
      for (const name of priorMigrations) {
        db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        db.prepare(
          "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        ).run(name, new Date().toISOString());
      }
      db.prepare(
        `INSERT INTO products
          (id, sku, name, unit, selling_price_centavos, tax_class,
           sc_pwd_eligible, quantity_on_hand, inventory_value_centavos,
           is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
      ).run(
        "legacy-both",
        "SYN-LEGACY-BOTH",
        "Synthetic legacy eligible product",
        "piece",
        100,
        "VATABLE",
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO products
          (id, sku, name, unit, selling_price_centavos, tax_class,
           sc_pwd_eligible, quantity_on_hand, inventory_value_centavos,
           is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
      ).run(
        "legacy-none",
        "SYN-LEGACY-NONE",
        "Synthetic legacy ineligible product",
        "piece",
        100,
        "VATABLE",
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      );

      migrateDatabase(db);

      expect(
        db
          .prepare(
            "SELECT sc_eligible, pwd_eligible, product_type FROM products WHERE id = ?",
          )
          .get("legacy-both"),
      ).toEqual({ sc_eligible: 1, pwd_eligible: 1, product_type: null });
      expect(
        db
          .prepare(
            "SELECT sc_eligible, pwd_eligible, product_type FROM products WHERE id = ?",
          )
          .get("legacy-none"),
      ).toEqual({ sc_eligible: 0, pwd_eligible: 0, product_type: null });
    } finally {
      db.close();
    }
  });

  it("leaves legacy concurrent open shifts untouched when store-wide enforcement cannot apply", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationsDirectory = resolve(
        repositoryRoot,
        "database/migrations",
      );
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => /^000[1-7]_.*\.sql$/u.test(name))
        .sort();
      for (const name of priorMigrations) {
        db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        db.prepare(
          "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        ).run(name, new Date().toISOString());
      }

      const now = new Date().toISOString();
      for (const [id, email] of [
        ["cashier-one", "cashier-one@example.test"],
        ["cashier-two", "cashier-two@example.test"],
      ]) {
        db.prepare(
          `INSERT INTO users
            (id, email, password_hash, role, is_active, created_at, updated_at)
           VALUES (?, ?, 'synthetic-hash', 'cashier', 1, ?, ?)`,
        ).run(id, email, now, now);
        db.prepare(
          `INSERT INTO shifts
            (id, cashier_user_id, opened_at, opening_cash_centavos,
             expected_cash_centavos)
           VALUES (?, ?, ?, 0, 0)`,
        ).run(`open-${id}`, id, now);
      }

      expect(() => migrateDatabase(db)).toThrow();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM shifts WHERE closed_at IS NULL",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        db
          .prepare(
            "SELECT name FROM schema_migrations WHERE name = '0008_single_store_register.sql'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("PRAGMA index_list(shifts)")
          .all()
          .some(
            (index) =>
              (index as { name?: string }).name ===
              "shifts_one_open_per_cashier_idx",
          ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
