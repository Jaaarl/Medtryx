CREATE TABLE stock_receipts (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE CHECK (length(trim(draft_id)) = 36),
  source TEXT NOT NULL CHECK (source = 'AI_RECEIPT_IMPORT'),
  reference TEXT CHECK (reference IS NULL OR length(trim(reference)) <= 200),
  supplier TEXT CHECK (supplier IS NULL OR length(trim(supplier)) <= 160),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX stock_receipts_created_at_idx
  ON stock_receipts(created_at DESC, id);

CREATE TABLE stock_receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES stock_receipts(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  stock_event_id TEXT NOT NULL UNIQUE REFERENCES stock_events(id) ON DELETE RESTRICT,
  inventory_lot_id TEXT REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  original_description TEXT NOT NULL CHECK (length(trim(original_description)) BETWEEN 1 AND 500),
  source_quantity TEXT NOT NULL CHECK (length(source_quantity) <= 80),
  source_unit_cost TEXT NOT NULL CHECK (length(source_unit_cost) <= 40),
  source_line_total TEXT NOT NULL CHECK (length(source_line_total) <= 40),
  source_lot TEXT NOT NULL CHECK (length(source_lot) <= 100),
  source_expiry TEXT NOT NULL CHECK (length(source_expiry) <= 80),
  received_quantity INTEGER NOT NULL CHECK (received_quantity > 0),
  received_unit_cost_centavos INTEGER NOT NULL CHECK (received_unit_cost_centavos >= 0),
  conversion_factor INTEGER CHECK (conversion_factor IS NULL OR conversion_factor > 1),
  created_at TEXT NOT NULL,
  UNIQUE (receipt_id, line_number)
);

CREATE INDEX stock_receipt_lines_product_idx
  ON stock_receipt_lines(product_id, created_at DESC);

CREATE TRIGGER stock_receipts_no_update
BEFORE UPDATE ON stock_receipts
BEGIN
  SELECT RAISE(ABORT, 'stock_receipts_are_immutable');
END;

CREATE TRIGGER stock_receipts_no_delete
BEFORE DELETE ON stock_receipts
BEGIN
  SELECT RAISE(ABORT, 'stock_receipts_are_immutable');
END;

CREATE TRIGGER stock_receipt_lines_no_update
BEFORE UPDATE ON stock_receipt_lines
BEGIN
  SELECT RAISE(ABORT, 'stock_receipt_lines_are_immutable');
END;

CREATE TRIGGER stock_receipt_lines_no_delete
BEFORE DELETE ON stock_receipt_lines
BEGIN
  SELECT RAISE(ABORT, 'stock_receipt_lines_are_immutable');
END;
