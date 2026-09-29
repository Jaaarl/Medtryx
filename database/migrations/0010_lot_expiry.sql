CREATE TEMP TABLE lot_expiry_migration_guard (
  balanced INTEGER CONSTRAINT lot_expiry_requires_reconciled_stock CHECK (balanced = 1)
);

INSERT INTO lot_expiry_migration_guard (balanced)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.quantity_on_hand <> coalesce((
    SELECT sum(e.quantity_delta) FROM stock_events e WHERE e.product_id = p.id
  ), 0)
     OR p.inventory_value_centavos <> coalesce((
    SELECT sum(e.inventory_value_delta_centavos) FROM stock_events e WHERE e.product_id = p.id
  ), 0)
) THEN 0 ELSE 1 END;

DROP TABLE lot_expiry_migration_guard;

ALTER TABLE products
  ADD COLUMN tracks_lots INTEGER NOT NULL DEFAULT 0
  CHECK (tracks_lots IN (0, 1));

ALTER TABLE stock_events ADD COLUMN supplier TEXT;

CREATE TABLE inventory_lots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  lot_code TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(lot_code)) BETWEEN 1 AND 100),
  expiry_date TEXT NOT NULL CHECK (
    length(expiry_date) = 10 AND expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (product_id, lot_code, expiry_date),
  UNIQUE (product_id, id)
);

CREATE INDEX inventory_lots_product_expiry_idx
  ON inventory_lots(product_id, expiry_date, lot_code, id);

CREATE TABLE lot_reconciliations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE lot_stock_movements (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  lot_id TEXT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'LEGACY_UNALLOCATED', 'RECEIPT', 'OPENING', 'ADJUSTMENT', 'WRITE_OFF',
    'SALE', 'REVERSAL', 'RECONCILIATION_IN', 'RECONCILIATION_OUT'
  )),
  stock_event_id TEXT REFERENCES stock_events(id) ON DELETE RESTRICT,
  sale_line_id TEXT REFERENCES sale_lines(id) ON DELETE RESTRICT,
  reversal_line_id TEXT REFERENCES sale_reversal_lines(id) ON DELETE RESTRICT,
  reconciliation_id TEXT REFERENCES lot_reconciliations(id) ON DELETE RESTRICT,
  quantity_delta INTEGER NOT NULL,
  inventory_value_delta_centavos INTEGER NOT NULL,
  unit_cost_centavos INTEGER CHECK (unit_cost_centavos IS NULL OR unit_cost_centavos >= 0),
  reason TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (quantity_delta <> 0 OR inventory_value_delta_centavos <> 0),
  CHECK ((lot_id IS NULL AND movement_type IN ('LEGACY_UNALLOCATED', 'RECEIPT', 'OPENING', 'ADJUSTMENT', 'WRITE_OFF', 'SALE', 'REVERSAL', 'RECONCILIATION_OUT')) OR lot_id IS NOT NULL),
  CHECK (movement_type NOT IN ('RECONCILIATION_IN', 'RECONCILIATION_OUT') OR reconciliation_id IS NOT NULL),
  FOREIGN KEY (product_id, lot_id) REFERENCES inventory_lots(product_id, id) ON DELETE RESTRICT
);

CREATE INDEX lot_stock_movements_product_sequence_idx
  ON lot_stock_movements(product_id, sequence DESC);
CREATE INDEX lot_stock_movements_lot_sequence_idx
  ON lot_stock_movements(lot_id, sequence DESC);
CREATE INDEX lot_stock_movements_stock_event_idx
  ON lot_stock_movements(stock_event_id);
CREATE INDEX lot_stock_movements_sale_line_idx
  ON lot_stock_movements(sale_line_id);

CREATE TABLE sale_line_lot_allocations (
  id TEXT PRIMARY KEY,
  sale_line_id TEXT NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  allocated_cogs_centavos INTEGER NOT NULL CHECK (allocated_cogs_centavos >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (sale_line_id, lot_id)
);

CREATE INDEX sale_line_lot_allocations_lot_idx
  ON sale_line_lot_allocations(lot_id, sale_line_id);

CREATE TRIGGER lot_stock_movements_no_update
BEFORE UPDATE ON lot_stock_movements
BEGIN
  SELECT RAISE(ABORT, 'lot_stock_movements_are_append_only');
END;

CREATE TRIGGER lot_stock_movements_no_delete
BEFORE DELETE ON lot_stock_movements
BEGIN
  SELECT RAISE(ABORT, 'lot_stock_movements_are_append_only');
END;

CREATE TRIGGER lot_reconciliations_no_update
BEFORE UPDATE ON lot_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'lot_reconciliations_are_append_only');
END;

CREATE TRIGGER lot_reconciliations_no_delete
BEFORE DELETE ON lot_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'lot_reconciliations_are_append_only');
END;

CREATE TRIGGER inventory_lots_identity_immutable
BEFORE UPDATE OF product_id, lot_code, expiry_date, created_at, created_by_user_id ON inventory_lots
BEGIN
  SELECT RAISE(ABORT, 'inventory_lot_identity_is_immutable');
END;

CREATE TRIGGER inventory_lots_no_delete
BEFORE DELETE ON inventory_lots
BEGIN
  SELECT RAISE(ABORT, 'inventory_lots_are_immutable');
END;

CREATE TRIGGER sale_line_lot_allocations_no_update
BEFORE UPDATE ON sale_line_lot_allocations
BEGIN
  SELECT RAISE(ABORT, 'sale_line_lot_allocations_are_immutable');
END;

CREATE TRIGGER sale_line_lot_allocations_no_delete
BEFORE DELETE ON sale_line_lot_allocations
BEGIN
  SELECT RAISE(ABORT, 'sale_line_lot_allocations_are_immutable');
END;

INSERT INTO lot_stock_movements
  (id, product_id, lot_id, movement_type, stock_event_id, quantity_delta,
   inventory_value_delta_centavos, unit_cost_centavos, reason, actor_user_id, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-a' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       e.product_id, NULL, e.event_type, e.id, e.quantity_delta,
       e.inventory_value_delta_centavos, e.unit_cost_centavos, e.reason,
       e.actor_user_id, e.created_at
FROM stock_events e;

CREATE TRIGGER lot_stock_movements_no_negative_balance
BEFORE INSERT ON lot_stock_movements
WHEN coalesce((
  SELECT sum(existing.quantity_delta)
  FROM lot_stock_movements existing
  WHERE existing.product_id = NEW.product_id
    AND existing.lot_id IS NEW.lot_id
), 0) + NEW.quantity_delta < 0
BEGIN
  SELECT RAISE(ABORT, 'lot_stock_balance_cannot_be_negative');
END;

INSERT INTO settings (key, value_json, updated_at, updated_by)
VALUES ('inventory_expiry', '{"warningDays":30}', datetime('now'), NULL)
ON CONFLICT (key) DO NOTHING;
