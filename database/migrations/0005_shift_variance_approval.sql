ALTER TABLE shifts
  ADD COLUMN variance_approval_status TEXT NOT NULL DEFAULT 'NONE'
  CHECK (variance_approval_status IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE shifts
  ADD COLUMN variance_approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE shifts ADD COLUMN variance_approved_at TEXT;
ALTER TABLE shifts ADD COLUMN variance_approval_note TEXT;

UPDATE shifts
SET variance_approval_status = 'PENDING'
WHERE closed_at IS NOT NULL AND variance_centavos <> 0;

CREATE INDEX shifts_variance_approval_idx
  ON shifts(variance_approval_status, closed_at, opened_at);
