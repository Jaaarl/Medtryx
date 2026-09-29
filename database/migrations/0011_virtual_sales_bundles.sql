CREATE TABLE sales_bundles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(code)) BETWEEN 1 AND 48),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sales_bundle_versions (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES sales_bundles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  code_snapshot TEXT NOT NULL,
  name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) BETWEEN 1 AND 160),
  active_from TEXT NOT NULL CHECK (length(active_from) = 10),
  active_until TEXT CHECK (active_until IS NULL OR length(active_until) = 10),
  max_quantity_per_sale INTEGER CHECK (
    max_quantity_per_sale IS NULL OR max_quantity_per_sale BETWEEN 1 AND 1000
  ),
  reduction_type TEXT NOT NULL CHECK (reduction_type IN ('PERCENT', 'AMOUNT')),
  reduction_value INTEGER NOT NULL CHECK (reduction_value > 0),
  suggested_price_centavos INTEGER NOT NULL CHECK (suggested_price_centavos > 0),
  promotional_price_centavos INTEGER NOT NULL CHECK (promotional_price_centavos > 0),
  price_rule_version TEXT NOT NULL,
  discount_interaction_rule TEXT NOT NULL CHECK (
    discount_interaction_rule = 'MORE_FAVORABLE_NO_STACK_V1'
  ),
  approved_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (bundle_id, version),
  UNIQUE (bundle_id, id),
  CHECK (active_until IS NULL OR active_until >= active_from)
);

CREATE INDEX sales_bundle_versions_bundle_idx
  ON sales_bundle_versions(bundle_id, version DESC);

CREATE TABLE sales_bundle_version_components (
  bundle_version_id TEXT NOT NULL REFERENCES sales_bundle_versions(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  component_order INTEGER NOT NULL CHECK (component_order > 0),
  PRIMARY KEY (bundle_version_id, product_id),
  UNIQUE (bundle_version_id, component_order)
);

CREATE TABLE sale_bundle_snapshots (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  bundle_id TEXT NOT NULL REFERENCES sales_bundles(id) ON DELETE RESTRICT,
  bundle_version_id TEXT NOT NULL REFERENCES sales_bundle_versions(id) ON DELETE RESTRICT,
  code_snapshot TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  version_snapshot INTEGER NOT NULL CHECK (version_snapshot > 0),
  active_from_snapshot TEXT NOT NULL,
  active_until_snapshot TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  max_quantity_per_sale_snapshot INTEGER,
  regular_total_centavos INTEGER NOT NULL CHECK (regular_total_centavos > 0),
  promotional_price_per_bundle_centavos INTEGER NOT NULL CHECK (promotional_price_per_bundle_centavos > 0),
  promotional_discount_offered_centavos INTEGER NOT NULL CHECK (promotional_discount_offered_centavos >= 0),
  promotional_discount_applied_centavos INTEGER NOT NULL CHECK (promotional_discount_applied_centavos >= 0),
  price_rule_version TEXT NOT NULL,
  discount_interaction_rule TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, bundle_id)
);

CREATE INDEX sale_bundle_snapshots_sale_idx
  ON sale_bundle_snapshots(sale_id, id);

CREATE TABLE sale_bundle_component_snapshots (
  id TEXT PRIMARY KEY,
  sale_bundle_snapshot_id TEXT NOT NULL REFERENCES sale_bundle_snapshots(id) ON DELETE RESTRICT,
  sale_line_id TEXT NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  component_quantity_per_bundle INTEGER NOT NULL CHECK (component_quantity_per_bundle > 0),
  total_quantity INTEGER NOT NULL CHECK (total_quantity > 0),
  regular_unit_price_centavos INTEGER NOT NULL CHECK (regular_unit_price_centavos > 0),
  regular_line_total_centavos INTEGER NOT NULL CHECK (regular_line_total_centavos > 0),
  promotional_discount_allocated_centavos INTEGER NOT NULL CHECK (promotional_discount_allocated_centavos >= 0),
  promotional_discount_applied_centavos INTEGER NOT NULL CHECK (promotional_discount_applied_centavos >= 0),
  selected_statutory_treatment TEXT NOT NULL CHECK (
    selected_statutory_treatment IN ('REGULAR', 'SENIOR_CITIZEN', 'PWD')
  ),
  tax_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sale_bundle_snapshot_id, product_id),
  UNIQUE (sale_line_id)
);

CREATE INDEX sale_bundle_component_snapshots_product_idx
  ON sale_bundle_component_snapshots(product_id, sale_bundle_snapshot_id);

ALTER TABLE sale_lines
  ADD COLUMN bundle_promotion_discount_centavos INTEGER NOT NULL DEFAULT 0
  CHECK (bundle_promotion_discount_centavos >= 0);

CREATE TRIGGER sales_bundle_versions_no_update
BEFORE UPDATE ON sales_bundle_versions
BEGIN
  SELECT RAISE(ABORT, 'sales_bundle_versions_are_immutable');
END;

CREATE TRIGGER sales_bundle_versions_no_delete
BEFORE DELETE ON sales_bundle_versions
BEGIN
  SELECT RAISE(ABORT, 'sales_bundle_versions_are_immutable');
END;

CREATE TRIGGER sales_bundle_version_components_no_update
BEFORE UPDATE ON sales_bundle_version_components
BEGIN
  SELECT RAISE(ABORT, 'sales_bundle_version_components_are_immutable');
END;

CREATE TRIGGER sales_bundle_version_components_no_delete
BEFORE DELETE ON sales_bundle_version_components
BEGIN
  SELECT RAISE(ABORT, 'sales_bundle_version_components_are_immutable');
END;

CREATE TRIGGER sale_bundle_snapshots_no_update
BEFORE UPDATE ON sale_bundle_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bundle_snapshots_are_immutable');
END;

CREATE TRIGGER sale_bundle_snapshots_no_delete
BEFORE DELETE ON sale_bundle_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bundle_snapshots_are_immutable');
END;

CREATE TRIGGER sale_bundle_component_snapshots_no_update
BEFORE UPDATE ON sale_bundle_component_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bundle_component_snapshots_are_immutable');
END;

CREATE TRIGGER sale_bundle_component_snapshots_no_delete
BEFORE DELETE ON sale_bundle_component_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bundle_component_snapshots_are_immutable');
END;
