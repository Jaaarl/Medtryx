ALTER TABLE sales
  ADD COLUMN cash_rounding_mode TEXT NOT NULL DEFAULT 'NONE'
  CHECK (cash_rounding_mode IN ('NONE', 'NEAREST_25_CENTAVOS'));

ALTER TABLE sales
  ADD COLUMN cash_rounding_adjustment_centavos INTEGER NOT NULL DEFAULT 0
  CHECK (cash_rounding_adjustment_centavos BETWEEN -12 AND 12);

ALTER TABLE sale_reversals
  ADD COLUMN cash_rounding_adjustment_centavos INTEGER NOT NULL DEFAULT 0
  CHECK (cash_rounding_adjustment_centavos BETWEEN -12 AND 12);
