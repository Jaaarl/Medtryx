INSERT INTO settings (key, value_json, updated_at, updated_by)
VALUES ('checkout_inventory', '{"allowStockCountOverride":false,"policyVersion":1}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE checkout_stock_override_records (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  stock_event_id TEXT NOT NULL UNIQUE REFERENCES stock_events(id) ON DELETE RESTRICT,
  recorded_quantity INTEGER NOT NULL CHECK (recorded_quantity >= 0),
  physical_quantity INTEGER NOT NULL CHECK (physical_quantity > recorded_quantity),
  correction_quantity INTEGER NOT NULL CHECK (correction_quantity > 0),
  sale_quantity INTEGER NOT NULL CHECK (sale_quantity > 0),
  reason_category TEXT NOT NULL CHECK (reason_category IN ('COUNT_DISCREPANCY', 'OTHER')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  cost_source_type TEXT NOT NULL CHECK (cost_source_type IN ('WEIGHTED_AVERAGE', 'OPENING', 'RECEIPT')),
  cost_source_event_id TEXT REFERENCES stock_events(id) ON DELETE RESTRICT,
  cost_source_sequence INTEGER,
  estimated_cost INTEGER NOT NULL CHECK (estimated_cost IN (0, 1)),
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  inventory_value_delta_centavos INTEGER NOT NULL CHECK (inventory_value_delta_centavos >= 0),
  stock_state_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, product_id),
  CHECK (physical_quantity - recorded_quantity = correction_quantity),
  CHECK ((cost_source_type = 'WEIGHTED_AVERAGE' AND cost_source_event_id IS NULL) OR
         (cost_source_type <> 'WEIGHTED_AVERAGE' AND cost_source_event_id IS NOT NULL))
);

CREATE INDEX checkout_stock_override_sale_idx
  ON checkout_stock_override_records(sale_id, created_at);
CREATE INDEX checkout_stock_override_product_idx
  ON checkout_stock_override_records(product_id, created_at);

CREATE TABLE checkout_stock_override_lots (
  id TEXT PRIMARY KEY,
  override_record_id TEXT NOT NULL REFERENCES checkout_stock_override_records(id) ON DELETE RESTRICT,
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  lot_code_snapshot TEXT NOT NULL,
  expiry_date_snapshot TEXT NOT NULL,
  recorded_quantity INTEGER NOT NULL CHECK (recorded_quantity >= 0),
  physical_quantity INTEGER NOT NULL CHECK (physical_quantity > recorded_quantity),
  correction_quantity INTEGER NOT NULL CHECK (correction_quantity > 0),
  sale_quantity INTEGER NOT NULL CHECK (sale_quantity >= 0),
  UNIQUE (override_record_id, lot_id),
  CHECK (physical_quantity - recorded_quantity = correction_quantity)
);

CREATE TABLE checkout_stock_override_reviews (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  override_record_id TEXT NOT NULL REFERENCES checkout_stock_override_records(id) ON DELETE RESTRICT,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('REVIEWED', 'UNREVIEWED')),
  note TEXT CHECK (note IS NULL OR length(trim(note)) <= 500),
  created_at TEXT NOT NULL
);

CREATE INDEX checkout_stock_override_reviews_latest_idx
  ON checkout_stock_override_reviews(override_record_id, sequence DESC);

CREATE TRIGGER checkout_stock_override_records_immutable_update
BEFORE UPDATE ON checkout_stock_override_records
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override evidence is immutable');
END;
CREATE TRIGGER checkout_stock_override_records_immutable_delete
BEFORE DELETE ON checkout_stock_override_records
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override evidence is immutable');
END;
CREATE TRIGGER checkout_stock_override_lots_immutable_update
BEFORE UPDATE ON checkout_stock_override_lots
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override lot evidence is immutable');
END;
CREATE TRIGGER checkout_stock_override_lots_immutable_delete
BEFORE DELETE ON checkout_stock_override_lots
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override lot evidence is immutable');
END;
CREATE TRIGGER checkout_stock_override_reviews_immutable_update
BEFORE UPDATE ON checkout_stock_override_reviews
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override reviews are append only');
END;
CREATE TRIGGER checkout_stock_override_reviews_immutable_delete
BEFORE DELETE ON checkout_stock_override_reviews
BEGIN
  SELECT RAISE(ABORT, 'checkout stock override reviews are append only');
END;
