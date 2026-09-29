DROP INDEX shifts_one_open_per_cashier_idx;

CREATE UNIQUE INDEX shifts_one_open_store_idx
  ON shifts ((1))
  WHERE closed_at IS NULL;
