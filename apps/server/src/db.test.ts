import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateDatabase, repositoryRoot } from "./db.js";

describe("database migrations", () => {
  it("allows manual sales without shifts while preserving existing sale references", () => {
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
        .filter((entry) => /^\d+_[a-z0-9_-]+\.sql$/iu.test(entry))
        .filter((entry) => Number(entry.slice(0, 4)) < 23)
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
         VALUES ('manual-migration-owner', 'manual-migration@example.test',
           'synthetic-hash', 'owner', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO shifts
           (id, cashier_user_id, opened_at, opening_cash_centavos,
            expected_cash_centavos)
         VALUES ('manual-migration-shift', 'manual-migration-owner', ?, 0, 0)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sales
          (id, transaction_id, business_date, request_key, request_hash,
           cashier_user_id, shift_id, benefit_type, customer_id_checked,
           payment_method, subtotal_centavos, vat_centavos,
           vat_removed_centavos, senior_discount_centavos,
           pwd_discount_centavos, amount_due_centavos, tax_policy_version,
           created_at)
         VALUES ('manual-migration-sale', 'MTX-20261009-000001', '2026-10-09',
           'migration-sale-key', 'migration-sale-hash',
           'manual-migration-owner', 'manual-migration-shift', 'REGULAR', 0,
           'CASH', 100, 0, 0, 0, 0, 100, 'LEGACY', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sale_reversals
          (id, reversal_transaction_id, sale_id, approved_by_user_id, reason,
           refund_method, amount_centavos, cash_shift_id, created_at)
         VALUES ('manual-migration-reversal', 'REV-20261009-000001',
           'manual-migration-sale', 'manual-migration-owner',
           'Synthetic migration fixture', 'QR', 100, NULL, ?)`,
      ).run(now);

      migrateDatabase(db);

      expect(
        db
          .prepare(
            "SELECT shift_id FROM sales WHERE id = 'manual-migration-sale'",
          )
          .get(),
      ).toEqual({ shift_id: "manual-migration-shift" });
      expect(
        db
          .prepare(
            "SELECT sale_id FROM sale_reversals WHERE id = 'manual-migration-reversal'",
          )
          .get(),
      ).toEqual({ sale_id: "manual-migration-sale" });
      expect(
        (
          db.pragma("table_info(sales)") as {
            name: string;
            notnull: number;
          }[]
        ).find((column) => column.name === "shift_id")?.notnull,
      ).toBe(0);
      db.prepare(
        `INSERT INTO sales
          (id, transaction_id, business_date, request_key, request_hash,
           cashier_user_id, shift_id, benefit_type, customer_id_checked,
           payment_method, subtotal_centavos, vat_centavos,
           vat_removed_centavos, senior_discount_centavos,
           pwd_discount_centavos, amount_due_centavos, tax_policy_version,
           created_at)
         VALUES ('manual-migration-no-shift', 'MTX-20261009-000002',
           '2026-10-09', 'manual-no-shift-key', 'manual-no-shift-hash',
           'manual-migration-owner', NULL, 'REGULAR', 0, 'CASH', 100, 0,
           0, 0, 0, 100, 'LEGACY', ?)`,
      ).run(now);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rolls old copied sale rows into one journal day and keeps their edits", () => {
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
        .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/iu.test(name))
        .filter((name) => Number(name.slice(0, 4)) < 22)
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
         VALUES ('journal-owner', 'journal-owner@example.test', 'synthetic-hash', 'owner', 1, ?, ?)`,
      ).run(now, now);
      const insertLegacyCopy = db.prepare(
        `INSERT INTO daily_sales_ledger
           (source_sale_id, source_business_date, business_month,
            invoice_number, senior_discount_centavos, non_vat_centavos,
            vatable_sales_centavos, total_vat_centavos,
            gross_sales_centavos, net_sales_centavos, edited_at,
            edited_by_user_id)
         VALUES (?, '2026-10-09', '2026-10', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertLegacyCopy.run(
        "legacy-journal-sale-1",
        "MTX-20261009-000001",
        100,
        0,
        10_000,
        1_200,
        11_200,
        10_000,
        null,
        null,
      );
      insertLegacyCopy.run(
        "legacy-journal-sale-2",
        "MTX-20261009-000002",
        200,
        500,
        20_000,
        2_400,
        22_400,
        20_000,
        "2026-10-09T12:00:00.000Z",
        "journal-owner",
      );

      migrateDatabase(db);

      expect(
        db
          .prepare(
            `SELECT source_business_date, business_month, journal_date,
                    invoice_number_range, senior_discount_centavos,
                    non_vat_centavos, vatable_sales_centavos,
                    total_vat_centavos, gross_sales_centavos,
                    net_sales_centavos, edited_at, edited_by_user_id
             FROM daily_sales_journal`,
          )
          .get(),
      ).toEqual({
        source_business_date: "2026-10-09",
        business_month: "2026-10",
        journal_date: "2026-10-09",
        invoice_number_range: "MTX-20261009-000001 – MTX-20261009-000002",
        senior_discount_centavos: 300,
        non_vat_centavos: 500,
        vatable_sales_centavos: 30_000,
        total_vat_centavos: 3_600,
        gross_sales_centavos: 33_600,
        net_sales_centavos: 30_000,
        edited_at: "2026-10-09T12:00:00.000Z",
        edited_by_user_id: "journal-owner",
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM daily_sales_ledger").get(),
      ).toEqual({ count: 2 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("preserves existing payment corrections while allowing the reverse direction", () => {
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
        .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/iu.test(name))
        .filter((name) => Number(name.slice(0, 4)) < 18)
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
         VALUES ('switch-cashier', 'switch@example.test', 'synthetic-hash', 'cashier', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO shifts
          (id, cashier_user_id, opened_at, opening_cash_centavos,
           expected_cash_centavos)
         VALUES ('switch-shift', 'switch-cashier', ?, 0, 10000)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sales
          (id, transaction_id, business_date, request_key, request_hash,
           cashier_user_id, shift_id, benefit_type, customer_id_checked,
           payment_method, subtotal_centavos, vat_centavos,
           vat_removed_centavos, senior_discount_centavos,
           pwd_discount_centavos, amount_due_centavos, tax_policy_version,
           created_at)
         VALUES ('switch-sale', 'MTX-20261007-000001', '2026-10-07',
           'switch-sale-key', 'switch-sale-hash', 'switch-cashier',
           'switch-shift', 'REGULAR', 0, 'QR', 11213, 0, 0, 0, 0,
           11213, 'SYNTHETIC', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sale_payment_switches
          (id, sale_id, cash_shift_id, changed_by_user_id, reason,
           from_method, to_method, cash_amount_centavos, qr_amount_centavos,
           cash_rounding_adjustment_centavos, created_at)
         VALUES ('switch-history', 'switch-sale', 'switch-shift',
           'switch-cashier', 'Historical cash to QR correction',
           'CASH', 'QR', 11225, 11213, 12, ?)`,
      ).run(now);

      migrateDatabase(db);

      expect(
        db
          .prepare(
            `SELECT from_method, to_method, cash_amount_centavos,
                    qr_amount_centavos, cash_rounding_adjustment_centavos
             FROM sale_payment_switches WHERE id = 'switch-history'`,
          )
          .get(),
      ).toEqual({
        from_method: "CASH",
        to_method: "QR",
        cash_amount_centavos: 11225,
        qr_amount_centavos: 11213,
        cash_rounding_adjustment_centavos: 12,
      });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

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
      db.prepare(
        `INSERT INTO shifts
          (id, cashier_user_id, opened_at, opening_cash_centavos,
           expected_cash_centavos)
         VALUES ('legacy-sale-shift', 'legacy-owner', ?, 0, 0)`,
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
           'legacy-sale-key', 'legacy-sale-hash', 'legacy-owner',
           'legacy-sale-shift', 'REGULAR', 0, 'CASH', 500, 0, 0, 0, 0,
           500, 'LEGACY-TAX', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO sale_lines
          (id, sale_id, line_number, product_id, product_name_snapshot,
           sku_snapshot, unit_snapshot, quantity, unit_price_centavos,
           tax_class_snapshot, sc_pwd_eligible_snapshot, benefit_applied,
           tax_basis_centavos, vat_centavos, vat_removed_centavos,
           discount_centavos, amount_due_centavos, allocated_cogs_centavos,
           tax_policy_version, created_at, sc_eligible_snapshot,
           pwd_eligible_snapshot, product_type_snapshot)
         VALUES ('legacy-sale-line', 'legacy-sale', 1, 'legacy-product',
           'Legacy tracked later', 'SYN-LEGACY-LOT', 'piece', 1, 500,
           'VATABLE', 0, 0, 446, 54, 0, 0, 500, 300, 'LEGACY-TAX', ?,
           0, 0, NULL)`,
      ).run(now);

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
      expect(
        db
          .prepare(
            `SELECT sl.product_name_snapshot, sl.unit_price_centavos,
                    sl.amount_due_centavos, sl.bundle_promotion_discount_centavos,
                    b.id AS bundle_snapshot
             FROM sale_lines sl LEFT JOIN sale_bundle_component_snapshots b
               ON b.sale_line_id = sl.id
             WHERE sl.id = 'legacy-sale-line'`,
          )
          .get(),
      ).toEqual({
        product_name_snapshot: "Legacy tracked later",
        unit_price_centavos: 500,
        amount_due_centavos: 500,
        bundle_promotion_discount_centavos: 0,
        bundle_snapshot: null,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM sale_bundle_snapshots").get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT bnpc_eligible, bnpc_category, bnpc_prescription_required FROM products
             WHERE id = 'legacy-product'`,
          )
          .get(),
      ).toEqual({
        bnpc_eligible: 0,
        bnpc_category: null,
        bnpc_prescription_required: 0,
      });
      expect(
        db
          .prepare(
            `SELECT benefit_treatment_snapshot, bnpc_discount_centavos,
                    bnpc_eligible_snapshot FROM sale_lines
             WHERE id = 'legacy-sale-line'`,
          )
          .get(),
      ).toEqual({
        benefit_treatment_snapshot: "REGULAR",
        bnpc_discount_centavos: 0,
        bnpc_eligible_snapshot: 0,
      });
      expect(
        db
          .prepare(
            `SELECT version, effective_from, enabled,
                    weekly_purchase_limit_centavos,
                    weekly_discount_limit_centavos
             FROM bnpc_policy_versions WHERE id = 'BNPC-JAO-24-02-INITIAL'`,
          )
          .get(),
      ).toEqual({
        version: "JAO-DTI-DA-DOE-24-02-2024",
        effective_from: "2024-03-25",
        enabled: 0,
        weekly_purchase_limit_centavos: 250_000,
        weekly_discount_limit_centavos: 12_500,
      });
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
