CREATE TABLE expense_cancellations (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  cash_movement_id TEXT UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  cancelled_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  created_at TEXT NOT NULL
);

CREATE INDEX expense_cancellations_created_at_idx
  ON expense_cancellations(created_at, expense_id);

CREATE TRIGGER expense_cancellations_no_update BEFORE UPDATE ON expense_cancellations
BEGIN SELECT RAISE(ABORT, 'expense_cancellations_are_append_only'); END;
CREATE TRIGGER expense_cancellations_no_delete BEFORE DELETE ON expense_cancellations
BEGIN SELECT RAISE(ABORT, 'expense_cancellations_are_append_only'); END;
