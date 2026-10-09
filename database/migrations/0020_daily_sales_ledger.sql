CREATE TABLE daily_sales_ledger (
  source_sale_id TEXT PRIMARY KEY,
  source_business_date TEXT NOT NULL,
  business_month TEXT NOT NULL CHECK (
    business_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  ),
  invoice_number TEXT NOT NULL CHECK (length(invoice_number) BETWEEN 1 AND 80),
  senior_discount_centavos INTEGER NOT NULL CHECK (senior_discount_centavos >= 0),
  non_vat_centavos INTEGER NOT NULL CHECK (non_vat_centavos >= 0),
  vatable_sales_centavos INTEGER NOT NULL CHECK (vatable_sales_centavos >= 0),
  total_vat_centavos INTEGER NOT NULL CHECK (total_vat_centavos >= 0),
  gross_sales_centavos INTEGER NOT NULL CHECK (gross_sales_centavos >= 0),
  net_sales_centavos INTEGER NOT NULL CHECK (net_sales_centavos >= 0),
  edited_at TEXT,
  edited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX daily_sales_ledger_month_idx
  ON daily_sales_ledger(business_month, invoice_number);
