CREATE TABLE stock_cost_corrections (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_basis INTEGER NOT NULL CHECK (quantity_basis > 0),
  old_unit_cost_centavos INTEGER NOT NULL CHECK (old_unit_cost_centavos >= 0),
  new_unit_cost_centavos INTEGER NOT NULL CHECK (new_unit_cost_centavos >= 0),
  old_inventory_value_centavos INTEGER NOT NULL CHECK (old_inventory_value_centavos >= 0),
  new_inventory_value_centavos INTEGER NOT NULL CHECK (new_inventory_value_centavos >= 0),
  inventory_value_delta_centavos INTEGER NOT NULL CHECK (inventory_value_delta_centavos <> 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (new_inventory_value_centavos - old_inventory_value_centavos = inventory_value_delta_centavos),
  CHECK (new_inventory_value_centavos = new_unit_cost_centavos * quantity_basis)
);

ALTER TABLE lot_stock_movements
  ADD COLUMN cost_correction_id TEXT REFERENCES stock_cost_corrections(id) ON DELETE RESTRICT;

CREATE INDEX lot_stock_movements_cost_correction_idx
  ON lot_stock_movements(cost_correction_id);

CREATE TRIGGER stock_cost_corrections_no_update
BEFORE UPDATE ON stock_cost_corrections
BEGIN
  SELECT RAISE(ABORT, 'stock_cost_corrections_are_append_only');
END;

CREATE TRIGGER stock_cost_corrections_no_delete
BEFORE DELETE ON stock_cost_corrections
BEGIN
  SELECT RAISE(ABORT, 'stock_cost_corrections_are_append_only');
END;
