import type Database from "better-sqlite3";

const appendOnlyTriggers = [
  `CREATE TRIGGER lot_stock_movements_no_update BEFORE UPDATE ON lot_stock_movements
   BEGIN SELECT RAISE(ABORT, 'lot_stock_movements_are_append_only'); END`,
  `CREATE TRIGGER lot_stock_movements_no_delete BEFORE DELETE ON lot_stock_movements
   BEGIN SELECT RAISE(ABORT, 'lot_stock_movements_are_append_only'); END`,
  `CREATE TRIGGER lot_stock_movements_no_negative_balance
   BEFORE INSERT ON lot_stock_movements
   WHEN coalesce((SELECT sum(quantity_delta) FROM lot_stock_movements existing
     WHERE existing.product_id = NEW.product_id AND existing.lot_id IS NEW.lot_id), 0) + NEW.quantity_delta < 0
   BEGIN SELECT RAISE(ABORT, 'lot_stock_balance_cannot_be_negative'); END`,
  `CREATE TRIGGER lot_reconciliations_no_update BEFORE UPDATE ON lot_reconciliations
   BEGIN SELECT RAISE(ABORT, 'lot_reconciliations_are_append_only'); END`,
  `CREATE TRIGGER lot_reconciliations_no_delete BEFORE DELETE ON lot_reconciliations
   BEGIN SELECT RAISE(ABORT, 'lot_reconciliations_are_append_only'); END`,
  `CREATE TRIGGER inventory_lots_identity_immutable
   BEFORE UPDATE OF product_id, lot_code, expiry_date, created_at, created_by_user_id ON inventory_lots
   BEGIN SELECT RAISE(ABORT, 'inventory_lot_identity_is_immutable'); END`,
  `CREATE TRIGGER inventory_lots_no_delete BEFORE DELETE ON inventory_lots
   BEGIN SELECT RAISE(ABORT, 'inventory_lots_are_immutable'); END`,
  `CREATE TRIGGER sale_line_lot_allocations_no_update BEFORE UPDATE ON sale_line_lot_allocations
   BEGIN SELECT RAISE(ABORT, 'sale_line_lot_allocations_are_immutable'); END`,
  `CREATE TRIGGER sale_line_lot_allocations_no_delete BEFORE DELETE ON sale_line_lot_allocations
   BEGIN SELECT RAISE(ABORT, 'sale_line_lot_allocations_are_immutable'); END`,
];

export function clearLotLedgerForTest(db: Database.Database): void {
  db.transaction(() => {
    for (const name of [
      "lot_stock_movements_no_update",
      "lot_stock_movements_no_delete",
      "lot_stock_movements_no_negative_balance",
      "lot_reconciliations_no_update",
      "lot_reconciliations_no_delete",
      "inventory_lots_identity_immutable",
      "inventory_lots_no_delete",
      "sale_line_lot_allocations_no_update",
      "sale_line_lot_allocations_no_delete",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    db.exec(
      `DELETE FROM sale_line_lot_allocations;
       DELETE FROM lot_stock_movements;
       DELETE FROM lot_reconciliations;
       DELETE FROM inventory_lots;`,
    );
    for (const sql of appendOnlyTriggers) db.exec(sql);
  })();
}

const bundleImmutableTriggers = [
  `CREATE TRIGGER sales_bundle_versions_no_update BEFORE UPDATE ON sales_bundle_versions
   BEGIN SELECT RAISE(ABORT, 'sales_bundle_versions_are_immutable'); END`,
  `CREATE TRIGGER sales_bundle_versions_no_delete BEFORE DELETE ON sales_bundle_versions
   BEGIN SELECT RAISE(ABORT, 'sales_bundle_versions_are_immutable'); END`,
  `CREATE TRIGGER sales_bundle_version_components_no_update BEFORE UPDATE ON sales_bundle_version_components
   BEGIN SELECT RAISE(ABORT, 'sales_bundle_version_components_are_immutable'); END`,
  `CREATE TRIGGER sales_bundle_version_components_no_delete BEFORE DELETE ON sales_bundle_version_components
   BEGIN SELECT RAISE(ABORT, 'sales_bundle_version_components_are_immutable'); END`,
  `CREATE TRIGGER sale_bundle_snapshots_no_update BEFORE UPDATE ON sale_bundle_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bundle_snapshots_are_immutable'); END`,
  `CREATE TRIGGER sale_bundle_snapshots_no_delete BEFORE DELETE ON sale_bundle_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bundle_snapshots_are_immutable'); END`,
  `CREATE TRIGGER sale_bundle_component_snapshots_no_update BEFORE UPDATE ON sale_bundle_component_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bundle_component_snapshots_are_immutable'); END`,
  `CREATE TRIGGER sale_bundle_component_snapshots_no_delete BEFORE DELETE ON sale_bundle_component_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bundle_component_snapshots_are_immutable'); END`,
];

export function clearBundleLedgerForTest(db: Database.Database): void {
  db.transaction(() => {
    for (const name of [
      "sales_bundle_versions_no_update",
      "sales_bundle_versions_no_delete",
      "sales_bundle_version_components_no_update",
      "sales_bundle_version_components_no_delete",
      "sale_bundle_snapshots_no_update",
      "sale_bundle_snapshots_no_delete",
      "sale_bundle_component_snapshots_no_update",
      "sale_bundle_component_snapshots_no_delete",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    db.exec(
      `DELETE FROM sale_bundle_component_snapshots;
       DELETE FROM sale_bundle_snapshots;
       DELETE FROM sales_bundle_version_components;
       DELETE FROM sales_bundle_versions;
       DELETE FROM sales_bundles;`,
    );
    for (const sql of bundleImmutableTriggers) db.exec(sql);
  })();
}

const bnpcImmutableTriggers = [
  `CREATE TRIGGER bnpc_policy_versions_no_update BEFORE UPDATE ON bnpc_policy_versions
   BEGIN SELECT RAISE(ABORT, 'bnpc_policy_versions_are_immutable'); END`,
  `CREATE TRIGGER bnpc_policy_versions_no_delete BEFORE DELETE ON bnpc_policy_versions
   BEGIN SELECT RAISE(ABORT, 'bnpc_policy_versions_are_immutable'); END`,
  `CREATE TRIGGER sale_bnpc_snapshots_no_update BEFORE UPDATE ON sale_bnpc_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bnpc_snapshots_are_immutable'); END`,
  `CREATE TRIGGER sale_bnpc_snapshots_no_delete BEFORE DELETE ON sale_bnpc_snapshots
   BEGIN SELECT RAISE(ABORT, 'sale_bnpc_snapshots_are_immutable'); END`,
  `CREATE TRIGGER bnpc_usage_events_no_update BEFORE UPDATE ON bnpc_usage_events
   BEGIN SELECT RAISE(ABORT, 'bnpc_usage_events_are_append_only'); END`,
  `CREATE TRIGGER bnpc_usage_events_no_delete BEFORE DELETE ON bnpc_usage_events
   BEGIN SELECT RAISE(ABORT, 'bnpc_usage_events_are_append_only'); END`,
];

export function clearBnpcLedgerForTest(db: Database.Database): void {
  db.transaction(() => {
    for (const name of [
      "bnpc_policy_versions_no_update",
      "bnpc_policy_versions_no_delete",
      "sale_bnpc_snapshots_no_update",
      "sale_bnpc_snapshots_no_delete",
      "bnpc_usage_events_no_update",
      "bnpc_usage_events_no_delete",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    db.exec(
      `DELETE FROM bnpc_usage_events;
       DELETE FROM sale_bnpc_snapshots;
       DELETE FROM bnpc_policy_versions;`,
    );
    for (const sql of bnpcImmutableTriggers) db.exec(sql);
  })();
}
