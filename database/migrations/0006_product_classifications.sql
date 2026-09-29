ALTER TABLE products
  ADD COLUMN sc_eligible INTEGER NOT NULL DEFAULT 0
  CHECK (sc_eligible IN (0, 1));

ALTER TABLE products
  ADD COLUMN pwd_eligible INTEGER NOT NULL DEFAULT 0
  CHECK (pwd_eligible IN (0, 1));

ALTER TABLE products
  ADD COLUMN product_type TEXT
  CHECK (product_type IS NULL OR product_type IN ('GENERIC', 'BRANDED'));

UPDATE products
SET sc_eligible = sc_pwd_eligible,
    pwd_eligible = sc_pwd_eligible;
