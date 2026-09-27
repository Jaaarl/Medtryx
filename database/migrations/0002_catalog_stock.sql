CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  barcode TEXT,
  unit TEXT NOT NULL,
  selling_price_centavos INTEGER NOT NULL CHECK (selling_price_centavos > 0),
  tax_class TEXT NOT NULL CHECK (tax_class IN ('VATABLE', 'VAT_EXEMPT', 'ZERO_RATED')),
  sc_pwd_eligible INTEGER NOT NULL CHECK (sc_pwd_eligible IN (0, 1)),
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  inventory_value_centavos INTEGER NOT NULL DEFAULT 0 CHECK (inventory_value_centavos >= 0),
  reorder_level INTEGER CHECK (reorder_level IS NULL OR reorder_level >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX products_barcode_unique_idx
  ON products(barcode COLLATE NOCASE)
  WHERE barcode IS NOT NULL;

CREATE INDEX products_active_name_idx ON products(is_active, name COLLATE NOCASE);

CREATE TABLE product_sku_sequence (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE stock_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('OPENING', 'RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'SALE', 'REVERSAL')
  ),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_centavos INTEGER CHECK (
    unit_cost_centavos IS NULL OR unit_cost_centavos >= 0
  ),
  inventory_value_delta_centavos INTEGER NOT NULL,
  reference TEXT,
  reason TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (
    event_type NOT IN ('ADJUSTMENT', 'WRITE_OFF') OR length(trim(coalesce(reason, ''))) > 0
  )
);

CREATE INDEX stock_events_product_sequence_idx
  ON stock_events(product_id, sequence DESC);
CREATE INDEX stock_events_created_at_idx ON stock_events(created_at);
