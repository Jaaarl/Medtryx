ALTER TABLE daily_sales_ledger
  ADD COLUMN ledger_date TEXT;

UPDATE daily_sales_ledger
SET ledger_date = source_business_date
WHERE ledger_date IS NULL;
