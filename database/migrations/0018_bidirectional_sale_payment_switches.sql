CREATE TABLE sale_payment_switches_rebuilt (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  cash_shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  from_method TEXT NOT NULL CHECK (from_method IN ('CASH', 'QR')),
  to_method TEXT NOT NULL CHECK (
    to_method IN ('CASH', 'QR') AND to_method <> from_method
  ),
  cash_amount_centavos INTEGER NOT NULL CHECK (cash_amount_centavos >= 0),
  qr_amount_centavos INTEGER NOT NULL CHECK (qr_amount_centavos >= 0),
  cash_rounding_adjustment_centavos INTEGER NOT NULL
    CHECK (cash_rounding_adjustment_centavos BETWEEN -12 AND 12),
  created_at TEXT NOT NULL,
  CHECK (
    cash_amount_centavos =
      qr_amount_centavos + cash_rounding_adjustment_centavos
  )
);

INSERT INTO sale_payment_switches_rebuilt (
  id, sale_id, cash_shift_id, changed_by_user_id, reason,
  from_method, to_method, cash_amount_centavos, qr_amount_centavos,
  cash_rounding_adjustment_centavos, created_at
)
SELECT
  id, sale_id, cash_shift_id, changed_by_user_id, reason,
  from_method, to_method, cash_amount_centavos, qr_amount_centavos,
  cash_rounding_adjustment_centavos, created_at
FROM sale_payment_switches;

DROP TABLE sale_payment_switches;
ALTER TABLE sale_payment_switches_rebuilt RENAME TO sale_payment_switches;

CREATE INDEX sale_payment_switches_created_idx
  ON sale_payment_switches(created_at, sale_id);
