-- @requires-foreign-keys-off
CREATE TABLE shifts_rebuilt (
  id TEXT PRIMARY KEY,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at TEXT NOT NULL,
  opening_cash_centavos INTEGER NOT NULL CHECK (opening_cash_centavos >= 0),
  closed_at TEXT,
  expected_cash_centavos INTEGER,
  actual_cash_count_centavos INTEGER CHECK (
    actual_cash_count_centavos IS NULL OR actual_cash_count_centavos >= 0
  ),
  variance_centavos INTEGER,
  variance_reason TEXT,
  close_actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  variance_approval_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (variance_approval_status IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED')),
  variance_approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  variance_approved_at TEXT,
  variance_approval_note TEXT,
  CHECK (
    (closed_at IS NULL AND actual_cash_count_centavos IS NULL AND variance_centavos IS NULL)
    OR (closed_at IS NOT NULL AND actual_cash_count_centavos IS NOT NULL AND variance_centavos IS NOT NULL)
  ),
  CHECK (closed_at IS NULL OR expected_cash_centavos IS NOT NULL),
  CHECK (variance_centavos IS NULL OR variance_centavos = actual_cash_count_centavos - expected_cash_centavos),
  CHECK (variance_centavos IS NULL OR variance_centavos = 0 OR length(trim(coalesce(variance_reason, ''))) >= 3)
);

INSERT INTO shifts_rebuilt (
  id, cashier_user_id, opened_at, opening_cash_centavos, closed_at,
  expected_cash_centavos, actual_cash_count_centavos, variance_centavos,
  variance_reason, close_actor_user_id, variance_approval_status,
  variance_approved_by_user_id, variance_approved_at, variance_approval_note
)
SELECT
  id, cashier_user_id, opened_at, opening_cash_centavos, closed_at,
  expected_cash_centavos, actual_cash_count_centavos, variance_centavos,
  variance_reason, close_actor_user_id, variance_approval_status,
  variance_approved_by_user_id, variance_approved_at, variance_approval_note
FROM shifts;

DROP TABLE shifts;
ALTER TABLE shifts_rebuilt RENAME TO shifts;

CREATE UNIQUE INDEX shifts_one_open_store_idx ON shifts ((1)) WHERE closed_at IS NULL;
CREATE INDEX shifts_opened_at_idx ON shifts(opened_at);
CREATE INDEX shifts_variance_approval_idx
  ON shifts(variance_approval_status, closed_at, opened_at);

-- Create the complete payments ledger; historical cash movements are unchanged.
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('LUNCH', 'DELIVERY', 'OTHER', 'STOCK_PURCHASE')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  description TEXT NOT NULL,
  payment_source TEXT NOT NULL CHECK (payment_source IN ('CASHIER', 'OWNER')),
  included_in_unit_cost INTEGER NOT NULL CHECK (included_in_unit_cost IN (0, 1)),
  product_amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (product_amount_centavos >= 0),
  delivery_fee_centavos INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_centavos >= 0),
  supplier TEXT NOT NULL DEFAULT '',
  invoice_reference TEXT NOT NULL DEFAULT '',
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shift_id TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  cash_movement_id TEXT UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (recorded_by_user_id, request_id),
  CHECK (category IN ('DELIVERY', 'STOCK_PURCHASE') OR (payment_source = 'CASHIER' AND included_in_unit_cost = 0)),
  CHECK (included_in_unit_cost = 0 OR category = 'DELIVERY'),
  CHECK (
    (category = 'STOCK_PURCHASE' AND product_amount_centavos > 0
      AND amount_centavos = product_amount_centavos + delivery_fee_centavos)
    OR (category <> 'STOCK_PURCHASE' AND product_amount_centavos = 0
      AND delivery_fee_centavos = 0 AND supplier = '' AND invoice_reference = '')
  ),
  CHECK (
    (payment_source = 'CASHIER' AND shift_id IS NOT NULL AND cash_movement_id IS NOT NULL)
    OR (payment_source = 'OWNER' AND shift_id IS NULL AND cash_movement_id IS NULL)
  )
);

CREATE INDEX expenses_business_date_idx ON expenses(business_date, created_at);
CREATE INDEX expenses_shift_idx ON expenses(shift_id);

CREATE TRIGGER expenses_no_update BEFORE UPDATE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses_are_append_only'); END;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses_are_append_only'); END;
