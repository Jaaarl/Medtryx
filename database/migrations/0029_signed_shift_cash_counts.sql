-- @requires-foreign-keys-off
CREATE TABLE shifts_rebuilt (
  id TEXT PRIMARY KEY,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at TEXT NOT NULL,
  opening_cash_centavos INTEGER NOT NULL CHECK (opening_cash_centavos >= 0),
  closed_at TEXT,
  expected_cash_centavos INTEGER,
  actual_cash_count_centavos INTEGER,
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
