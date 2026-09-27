CREATE TABLE reversal_sequences (
  business_date TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);

CREATE TABLE sale_reversals (
  id TEXT PRIMARY KEY,
  reversal_transaction_id TEXT NOT NULL UNIQUE,
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  refund_method TEXT NOT NULL CHECK (refund_method IN ('CASH', 'QR')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos >= 0),
  cash_shift_id TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (
    (refund_method = 'CASH' AND cash_shift_id IS NOT NULL)
    OR (refund_method = 'QR' AND cash_shift_id IS NULL)
  )
);

CREATE INDEX sale_reversals_created_at_idx
  ON sale_reversals(created_at, reversal_transaction_id);

CREATE TABLE sale_reversal_lines (
  id TEXT PRIMARY KEY,
  reversal_id TEXT NOT NULL REFERENCES sale_reversals(id) ON DELETE RESTRICT,
  sale_line_id TEXT NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  refund_amount_centavos INTEGER NOT NULL CHECK (refund_amount_centavos >= 0),
  stock_treatment TEXT NOT NULL CHECK (
    stock_treatment IN ('RESTOCK', 'WRITE_OFF')
  ),
  original_cogs_centavos INTEGER NOT NULL CHECK (original_cogs_centavos >= 0),
  cogs_restored_centavos INTEGER NOT NULL CHECK (cogs_restored_centavos >= 0),
  writeoff_centavos INTEGER NOT NULL CHECK (writeoff_centavos >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (reversal_id, sale_line_id),
  CHECK (cogs_restored_centavos + writeoff_centavos = original_cogs_centavos),
  CHECK (
    (stock_treatment = 'RESTOCK' AND cogs_restored_centavos = original_cogs_centavos AND writeoff_centavos = 0)
    OR (stock_treatment = 'WRITE_OFF' AND cogs_restored_centavos = 0 AND writeoff_centavos = original_cogs_centavos)
  )
);

CREATE INDEX sale_reversal_lines_reversal_idx
  ON sale_reversal_lines(reversal_id);

CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (
    movement_type IN ('CASH_IN', 'CASH_OUT', 'CASH_REFUND')
  ),
  amount_delta_centavos INTEGER NOT NULL CHECK (amount_delta_centavos <> 0),
  reversal_id TEXT UNIQUE REFERENCES sale_reversals(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (
    (movement_type = 'CASH_IN' AND amount_delta_centavos > 0 AND reversal_id IS NULL)
    OR (movement_type = 'CASH_OUT' AND amount_delta_centavos < 0 AND reversal_id IS NULL)
    OR (movement_type = 'CASH_REFUND' AND amount_delta_centavos < 0 AND reversal_id IS NOT NULL)
  )
);

CREATE INDEX cash_movements_shift_created_idx
  ON cash_movements(shift_id, created_at);
