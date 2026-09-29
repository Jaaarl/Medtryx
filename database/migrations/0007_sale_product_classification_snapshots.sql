ALTER TABLE sale_lines
  ADD COLUMN sc_eligible_snapshot INTEGER NOT NULL DEFAULT 0
  CHECK (sc_eligible_snapshot IN (0, 1));

ALTER TABLE sale_lines
  ADD COLUMN pwd_eligible_snapshot INTEGER NOT NULL DEFAULT 0
  CHECK (pwd_eligible_snapshot IN (0, 1));

ALTER TABLE sale_lines
  ADD COLUMN product_type_snapshot TEXT
  CHECK (product_type_snapshot IS NULL OR product_type_snapshot IN ('GENERIC', 'BRANDED'));

UPDATE sale_lines
SET sc_eligible_snapshot = sc_pwd_eligible_snapshot,
    pwd_eligible_snapshot = sc_pwd_eligible_snapshot;
