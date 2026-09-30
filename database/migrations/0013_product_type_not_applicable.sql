ALTER TABLE products
  ADD COLUMN product_type_applicable INTEGER NOT NULL DEFAULT 1
  CHECK (product_type_applicable IN (0, 1));

ALTER TABLE sale_lines
  ADD COLUMN product_type_applicable_snapshot INTEGER NOT NULL DEFAULT 1
  CHECK (product_type_applicable_snapshot IN (0, 1));
