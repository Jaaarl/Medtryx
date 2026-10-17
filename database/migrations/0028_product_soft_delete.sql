-- Preserve every product and ledger row; existing products remain visible.
ALTER TABLE products ADD COLUMN deleted_at TEXT;

CREATE INDEX products_not_deleted_name_idx
  ON products(name COLLATE NOCASE) WHERE deleted_at IS NULL;

-- A corrected replacement may use the barcode of a deleted mistake.
-- SKUs remain globally unique so old references cannot identify a new product.
DROP INDEX products_barcode_unique_idx;
CREATE UNIQUE INDEX products_barcode_unique_idx
  ON products(barcode COLLATE NOCASE)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER products_soft_delete_without_sales
BEFORE UPDATE OF deleted_at ON products
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
  EXISTS (SELECT 1 FROM sale_lines WHERE product_id = OLD.id) OR
  EXISTS (SELECT 1 FROM sale_reversal_lines WHERE product_id = OLD.id) OR
  EXISTS (SELECT 1 FROM sale_bundle_component_snapshots WHERE product_id = OLD.id) OR
  EXISTS (SELECT 1 FROM stock_events WHERE product_id = OLD.id AND event_type IN ('SALE', 'REVERSAL'))
)
BEGIN
  SELECT RAISE(ABORT, 'product_has_sales_history');
END;

CREATE TRIGGER products_soft_delete_empty_update
BEFORE UPDATE ON products
WHEN NEW.deleted_at IS NOT NULL AND (
  NEW.is_active <> 0 OR NEW.quantity_on_hand <> 0 OR NEW.inventory_value_centavos <> 0
)
BEGIN
  SELECT RAISE(ABORT, 'deleted_product_must_be_empty_and_inactive');
END;

CREATE TRIGGER products_soft_delete_empty_insert
BEFORE INSERT ON products
WHEN NEW.deleted_at IS NOT NULL AND (
  NEW.is_active <> 0 OR NEW.quantity_on_hand <> 0 OR NEW.inventory_value_centavos <> 0
)
BEGIN
  SELECT RAISE(ABORT, 'deleted_product_must_be_empty_and_inactive');
END;

-- Protect stale requests that prepared a checkout or edit before deletion.
CREATE TRIGGER products_soft_deleted_read_only
BEFORE UPDATE ON products
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'product_is_deleted');
END;

CREATE TRIGGER sale_lines_no_deleted_product
BEFORE INSERT ON sale_lines
WHEN EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'product_is_deleted');
END;
