import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./db.js";

// Synthetic fixtures only; never opens an application database.
export function applyMigrationsThrough(db: Database.Database, version: number) {
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const directory = resolve(repositoryRoot, "database/migrations");
  for (const name of readdirSync(directory)
    .filter(
      (name) =>
        /^\d+_[a-z0-9_-]+\.sql$/iu.test(name) &&
        Number(name.slice(0, 4)) <= version,
    )
    .sort()) {
    const sql = readFileSync(resolve(directory, name), "utf8");
    const foreignKeysOff = sql.includes("-- @requires-foreign-keys-off");
    if (foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          name,
          "2026-10-01T00:00:00.000Z",
        );
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}

export function insertMigrationFixture(
  db: Database.Database,
  table: string,
  row: Record<string, string | number | null>,
) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

export type MigrationSnapshot = Record<
  string,
  { columns: string[]; rows: unknown[] }
>;
export function snapshotMigrationTables(
  db: Database.Database,
  previous?: MigrationSnapshot,
): MigrationSnapshot {
  const tables = previous
    ? Object.keys(previous)
    : (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name);
  return Object.fromEntries(
    tables.map((table) => {
      const columns =
        previous?.[table]?.columns ??
        (db.pragma(`table_info("${table}")`) as Array<{ name: string }>).map(
          ({ name }) => name,
        );
      const rows = db
        .prepare(
          `SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`,
        )
        .all()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [table, { columns, rows }];
    }),
  );
}

export function seedProductionMigrationRecords(
  db: Database.Database,
  expectedCash: number | null = 10000,
  ownerHash = "synthetic-migration-hash",
) {
  const now = "2026-10-01T08:00:00.000Z";
  const insert = (table: string, row: Record<string, string | number | null>) =>
    insertMigrationFixture(db, table, row);
  for (const [id, role] of [
    ["upgrade-owner", "owner"],
    ["upgrade-cashier", "cashier"],
  ] as const) {
    insert("users", {
      id,
      email: `${id}@example.test`,
      username: id,
      password_hash: ownerHash,
      role,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
  }
  insert("sessions", {
    token_hash: "synthetic-session-hash",
    csrf_hash: "synthetic-csrf-hash",
    user_id: "upgrade-owner",
    created_at: now,
    last_seen_at: now,
    expires_at: "2099-01-01T00:00:00.000Z",
  });
  insert("shifts", {
    id: "upgrade-open",
    cashier_user_id: "upgrade-cashier",
    opened_at: now,
    opening_cash_centavos: 10000,
    expected_cash_centavos: expectedCash,
  });
  for (const status of ["NONE", "PENDING", "APPROVED", "REJECTED"]) {
    const variance = status === "NONE" ? 0 : -1000;
    insert("shifts", {
      id: `upgrade-closed-${status}`,
      cashier_user_id: "upgrade-cashier",
      opened_at: now,
      opening_cash_centavos: 10000,
      expected_cash_centavos: 10000,
      closed_at: now,
      actual_cash_count_centavos: 10000 + variance,
      variance_centavos: variance,
      variance_reason: variance ? "Recorded shortage" : null,
      close_actor_user_id: "upgrade-owner",
      variance_approval_status: status,
      variance_approved_by_user_id:
        status === "APPROVED" || status === "REJECTED" ? "upgrade-owner" : null,
      variance_approved_at:
        status === "APPROVED" || status === "REJECTED" ? now : null,
      variance_approval_note: "Preserve original review",
    });
  }
  insert("products", {
    id: "upgrade-product",
    sku: "SYN-UPGRADE-001",
    name: "Synthetic migration product",
    unit: "piece",
    selling_price_centavos: 11200,
    tax_class: "VATABLE",
    sc_pwd_eligible: 0,
    quantity_on_hand: 5,
    inventory_value_centavos: 17500,
    tracks_lots: 1,
    is_active: 1,
    created_at: now,
    updated_at: now,
  });
  insert("stock_events", {
    id: "upgrade-receipt-event",
    product_id: "upgrade-product",
    event_type: "RECEIPT",
    quantity_delta: 8,
    unit_cost_centavos: 3500,
    inventory_value_delta_centavos: 28000,
    reference: "SYN-INVOICE-001",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("stock_receipts", {
    id: "upgrade-receipt",
    draft_id: "10000000-0000-4000-8000-000000000001",
    source: "AI_RECEIPT_IMPORT",
    reference: "SYN-INVOICE-001",
    supplier: "Synthetic supplier",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("inventory_lots", {
    id: "upgrade-lot",
    product_id: "upgrade-product",
    lot_code: "SYN-UPGRADE-LOT",
    expiry_date: "2027-10-01",
    created_at: now,
    created_by_user_id: "upgrade-owner",
  });
  insert("lot_stock_movements", {
    id: "upgrade-receipt-lot-movement",
    product_id: "upgrade-product",
    lot_id: "upgrade-lot",
    movement_type: "RECEIPT",
    stock_event_id: "upgrade-receipt-event",
    quantity_delta: 8,
    inventory_value_delta_centavos: 28000,
    unit_cost_centavos: 3500,
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("stock_receipt_lines", {
    id: "upgrade-receipt-line",
    receipt_id: "upgrade-receipt",
    line_number: 1,
    product_id: "upgrade-product",
    stock_event_id: "upgrade-receipt-event",
    inventory_lot_id: "upgrade-lot",
    original_description: "Synthetic migration product",
    source_quantity: "8",
    source_unit_cost: "35.00",
    source_line_total: "280.00",
    source_lot: "SYN-UPGRADE-LOT",
    source_expiry: "2027-10-01",
    received_quantity: 8,
    received_unit_cost_centavos: 3500,
    created_at: now,
  });
  for (const suffix of ["sale", "refund", "switch"]) {
    const saleId = `upgrade-${suffix}`;
    insert("sales", {
      id: saleId,
      transaction_id: `SYN-${suffix}`,
      business_date: "2026-10-01",
      request_key: `synthetic-${suffix}-request`,
      request_hash: `synthetic-${suffix}-hash`,
      cashier_user_id: "upgrade-cashier",
      shift_id: "upgrade-closed-APPROVED",
      benefit_type: "REGULAR",
      customer_id_checked: 0,
      payment_method: suffix === "switch" ? "QR" : "CASH",
      subtotal_centavos: 11200,
      vat_centavos: 1200,
      vat_removed_centavos: 0,
      senior_discount_centavos: 0,
      pwd_discount_centavos: 0,
      amount_due_centavos: 11200,
      tax_policy_version: "SYNTHETIC",
      created_at: now,
    });
    insert("sale_lines", {
      id: `${saleId}-line`,
      sale_id: saleId,
      line_number: 1,
      product_id: "upgrade-product",
      product_name_snapshot: "Synthetic migration product",
      sku_snapshot: "SYN-UPGRADE-001",
      unit_snapshot: "piece",
      quantity: 1,
      unit_price_centavos: 11200,
      tax_class_snapshot: "VATABLE",
      sc_pwd_eligible_snapshot: 0,
      benefit_applied: 0,
      tax_basis_centavos: 10000,
      vat_centavos: 1200,
      vat_removed_centavos: 0,
      discount_centavos: 0,
      amount_due_centavos: 11200,
      allocated_cogs_centavos: 3500,
      tax_policy_version: "SYNTHETIC",
      created_at: now,
    });
    insert("stock_events", {
      id: `${saleId}-stock-event`,
      product_id: "upgrade-product",
      event_type: "SALE",
      quantity_delta: -1,
      unit_cost_centavos: 3500,
      inventory_value_delta_centavos: -3500,
      actor_user_id: "upgrade-cashier",
      created_at: now,
    });
    insert("lot_stock_movements", {
      id: `${saleId}-lot-movement`,
      product_id: "upgrade-product",
      lot_id: "upgrade-lot",
      movement_type: "SALE",
      stock_event_id: `${saleId}-stock-event`,
      sale_line_id: `${saleId}-line`,
      quantity_delta: -1,
      inventory_value_delta_centavos: -3500,
      unit_cost_centavos: 3500,
      actor_user_id: "upgrade-cashier",
      created_at: now,
    });
    insert("sale_line_lot_allocations", {
      id: `${saleId}-lot-allocation`,
      sale_line_id: `${saleId}-line`,
      lot_id: "upgrade-lot",
      quantity: 1,
      allocated_cogs_centavos: 3500,
      created_at: now,
    });
  }
  insert("stock_events", {
    id: "upgrade-override-event",
    product_id: "upgrade-product",
    event_type: "ADJUSTMENT",
    quantity_delta: 2,
    unit_cost_centavos: 3500,
    inventory_value_delta_centavos: 7000,
    reason: "Synthetic verified surplus",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("lot_stock_movements", {
    id: "upgrade-override-lot-movement",
    product_id: "upgrade-product",
    lot_id: "upgrade-lot",
    movement_type: "ADJUSTMENT",
    stock_event_id: "upgrade-override-event",
    quantity_delta: 2,
    inventory_value_delta_centavos: 7000,
    unit_cost_centavos: 3500,
    reason: "Synthetic verified surplus",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  db.prepare(
    "UPDATE products SET quantity_on_hand = 7, inventory_value_centavos = 24500 WHERE id = 'upgrade-product'",
  ).run();
  insert("checkout_stock_override_records", {
    id: "upgrade-override",
    sale_id: "upgrade-sale",
    cashier_user_id: "upgrade-cashier",
    product_id: "upgrade-product",
    stock_event_id: "upgrade-override-event",
    recorded_quantity: 6,
    physical_quantity: 8,
    correction_quantity: 2,
    sale_quantity: 1,
    reason_category: "COUNT_DISCREPANCY",
    reason: "Synthetic verified surplus",
    cost_source_type: "RECEIPT",
    cost_source_event_id: "upgrade-receipt-event",
    cost_source_sequence: 1,
    estimated_cost: 0,
    unit_cost_centavos: 3500,
    inventory_value_delta_centavos: 7000,
    stock_state_hash: "synthetic-state-hash",
    policy_version: 1,
    created_at: now,
  });
  insert("checkout_stock_override_lots", {
    id: "upgrade-override-lot",
    override_record_id: "upgrade-override",
    lot_id: "upgrade-lot",
    lot_code_snapshot: "SYN-UPGRADE-LOT",
    expiry_date_snapshot: "2027-10-01",
    recorded_quantity: 6,
    physical_quantity: 8,
    correction_quantity: 2,
    sale_quantity: 1,
  });
  insert("checkout_stock_override_reviews", {
    id: "upgrade-override-review",
    override_record_id: "upgrade-override",
    reviewer_user_id: "upgrade-owner",
    status: "REVIEWED",
    note: "Reviewed before upgrade",
    created_at: now,
  });
  insert("sale_reversals", {
    id: "upgrade-reversal",
    reversal_transaction_id: "SYN-REVERSAL",
    sale_id: "upgrade-refund",
    approved_by_user_id: "upgrade-owner",
    reason: "Synthetic migration refund",
    refund_method: "CASH",
    amount_centavos: 11200,
    cash_shift_id: "upgrade-closed-APPROVED",
    created_at: now,
  });
  insert("sale_reversal_lines", {
    id: "upgrade-reversal-line",
    reversal_id: "upgrade-reversal",
    sale_line_id: "upgrade-refund-line",
    product_id: "upgrade-product",
    quantity: 1,
    refund_amount_centavos: 11200,
    stock_treatment: "WRITE_OFF",
    original_cogs_centavos: 3500,
    cogs_restored_centavos: 0,
    writeoff_centavos: 3500,
    created_at: now,
  });
  insert("cash_movements", {
    id: "upgrade-refund-movement",
    shift_id: "upgrade-closed-APPROVED",
    movement_type: "CASH_REFUND",
    amount_delta_centavos: -11200,
    reversal_id: "upgrade-reversal",
    reason: "Synthetic migration refund",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("cash_movements", {
    id: "upgrade-cash-in",
    shift_id: "upgrade-open",
    movement_type: "CASH_IN",
    amount_delta_centavos: 5000,
    reason: "Synthetic owner cash-in",
    actor_user_id: "upgrade-owner",
    created_at: now,
  });
  insert("sale_payment_switches", {
    id: "upgrade-payment-switch",
    sale_id: "upgrade-switch",
    cash_shift_id: "upgrade-closed-APPROVED",
    changed_by_user_id: "upgrade-owner",
    reason: "Synthetic payment correction",
    from_method: "CASH",
    to_method: "QR",
    cash_amount_centavos: 11200,
    qr_amount_centavos: 11200,
    cash_rounding_adjustment_centavos: 0,
    created_at: now,
  });
  insert("daily_sales_journal", {
    source_business_date: "2026-10-01",
    business_month: "2026-10",
    journal_date: "2026-10-02",
    invoice_number_range: "MANUAL-001 – MANUAL-003",
    senior_discount_centavos: 0,
    non_vat_centavos: 0,
    vatable_sales_centavos: 30000,
    total_vat_centavos: 3600,
    gross_sales_centavos: 33600,
    net_sales_centavos: 30000,
    edited_at: now,
    edited_by_user_id: "upgrade-owner",
  });
  insert("daily_sales_ledger", {
    source_sale_id: "upgrade-sale",
    source_business_date: "2026-10-01",
    business_month: "2026-10",
    ledger_date: "2026-10-02",
    invoice_number: "MANUAL-001",
    senior_discount_centavos: 0,
    non_vat_centavos: 0,
    vatable_sales_centavos: 10000,
    total_vat_centavos: 1200,
    gross_sales_centavos: 11200,
    net_sales_centavos: 10000,
    edited_at: now,
    edited_by_user_id: "upgrade-owner",
  });
  insert("sale_sequences", { business_date: "2026-10-01", next_number: 4 });
  insert("reversal_sequences", { business_date: "2026-10-01", next_number: 2 });
  insert("audit_events", {
    id: "upgrade-audit",
    actor_user_id: "upgrade-owner",
    action: "synthetic.upgrade",
    entity_type: "sale",
    entity_id: "upgrade-sale",
    details_json: '{"synthetic":true}',
    created_at: now,
  });
}
