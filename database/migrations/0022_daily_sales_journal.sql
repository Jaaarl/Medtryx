CREATE TABLE daily_sales_journal (
  source_business_date TEXT PRIMARY KEY,
  business_month TEXT NOT NULL CHECK (
    business_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  ),
  journal_date TEXT NOT NULL,
  invoice_number_range TEXT NOT NULL CHECK (length(invoice_number_range) > 0),
  senior_discount_centavos INTEGER NOT NULL CHECK (senior_discount_centavos >= 0),
  non_vat_centavos INTEGER NOT NULL CHECK (non_vat_centavos >= 0),
  vatable_sales_centavos INTEGER NOT NULL CHECK (vatable_sales_centavos >= 0),
  total_vat_centavos INTEGER NOT NULL CHECK (total_vat_centavos >= 0),
  gross_sales_centavos INTEGER NOT NULL CHECK (gross_sales_centavos >= 0),
  net_sales_centavos INTEGER NOT NULL CHECK (net_sales_centavos >= 0),
  edited_at TEXT,
  edited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX daily_sales_journal_month_idx
  ON daily_sales_journal(business_month, source_business_date);

-- Preserve older journal edits by rolling copied invoice rows up to their
-- original sales day. Unedited rows are reseeded from source sales below.
INSERT INTO daily_sales_journal (
  source_business_date, business_month, journal_date, invoice_number_range,
  senior_discount_centavos, non_vat_centavos, vatable_sales_centavos,
  total_vat_centavos, gross_sales_centavos, net_sales_centavos,
  edited_at, edited_by_user_id
)
SELECT
  source_business_date,
  substr(source_business_date, 1, 7),
  source_business_date,
  CASE WHEN MIN(invoice_number) = MAX(invoice_number)
       THEN MIN(invoice_number)
       ELSE MIN(invoice_number) || ' – ' || MAX(invoice_number)
  END,
  SUM(senior_discount_centavos),
  SUM(non_vat_centavos),
  SUM(vatable_sales_centavos),
  SUM(total_vat_centavos),
  SUM(gross_sales_centavos),
  SUM(net_sales_centavos),
  MAX(edited_at),
  MAX(edited_by_user_id)
FROM daily_sales_ledger
GROUP BY source_business_date
HAVING MAX(CASE WHEN edited_at IS NULL THEN 0 ELSE 1 END) = 1;

INSERT OR IGNORE INTO daily_sales_journal (
  source_business_date, business_month, journal_date, invoice_number_range,
  senior_discount_centavos, non_vat_centavos, vatable_sales_centavos,
  total_vat_centavos, gross_sales_centavos, net_sales_centavos
)
SELECT
  sale_totals.business_date,
  substr(sale_totals.business_date, 1, 7),
  sale_totals.business_date,
  CASE WHEN sale_totals.first_invoice = sale_totals.last_invoice
       THEN sale_totals.first_invoice
       ELSE sale_totals.first_invoice || ' – ' || sale_totals.last_invoice
  END,
  sale_totals.senior_discount_centavos,
  line_totals.non_vat_centavos,
  line_totals.vatable_sales_centavos,
  sale_totals.total_vat_centavos,
  line_totals.gross_sales_centavos,
  line_totals.net_sales_centavos
FROM (
  SELECT business_date, MIN(transaction_id) AS first_invoice,
         MAX(transaction_id) AS last_invoice,
         SUM(senior_discount_centavos) AS senior_discount_centavos,
         SUM(vat_centavos) AS total_vat_centavos
  FROM sales
  GROUP BY business_date
) AS sale_totals
JOIN (
  SELECT s.business_date,
         COALESCE(SUM(CASE WHEN sl.tax_class_snapshot <> 'VATABLE'
                           THEN sl.amount_due_centavos ELSE 0 END), 0)
           AS non_vat_centavos,
         COALESCE(SUM(CASE WHEN sl.tax_class_snapshot = 'VATABLE'
                           THEN sl.tax_basis_centavos ELSE 0 END), 0)
           AS vatable_sales_centavos,
         COALESCE(SUM(sl.quantity * sl.unit_price_centavos), 0)
           AS gross_sales_centavos,
         COALESCE(SUM(sl.amount_due_centavos - sl.vat_centavos), 0)
           AS net_sales_centavos
  FROM sales s
  JOIN sale_lines sl ON sl.sale_id = s.id
  GROUP BY s.business_date
) AS line_totals ON line_totals.business_date = sale_totals.business_date;
