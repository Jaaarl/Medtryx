CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at TEXT NOT NULL,
  opening_cash_centavos INTEGER NOT NULL CHECK (opening_cash_centavos >= 0),
  closed_at TEXT,
  expected_cash_centavos INTEGER CHECK (
    expected_cash_centavos IS NULL OR expected_cash_centavos >= 0
  ),
  actual_cash_count_centavos INTEGER CHECK (
    actual_cash_count_centavos IS NULL OR actual_cash_count_centavos >= 0
  ),
  variance_centavos INTEGER,
  variance_reason TEXT,
  close_actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (closed_at IS NULL AND actual_cash_count_centavos IS NULL AND variance_centavos IS NULL)
    OR (closed_at IS NOT NULL AND actual_cash_count_centavos IS NOT NULL AND variance_centavos IS NOT NULL)
  ),
  CHECK (closed_at IS NULL OR expected_cash_centavos IS NOT NULL),
  CHECK (variance_centavos IS NULL OR variance_centavos = actual_cash_count_centavos - expected_cash_centavos),
  CHECK (variance_centavos IS NULL OR variance_centavos = 0 OR length(trim(coalesce(variance_reason, ''))) >= 3)
);

CREATE UNIQUE INDEX shifts_one_open_per_cashier_idx
  ON shifts(cashier_user_id)
  WHERE closed_at IS NULL;

CREATE INDEX shifts_opened_at_idx ON shifts(opened_at);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  business_date TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  benefit_type TEXT NOT NULL CHECK (
    benefit_type IN ('REGULAR', 'SENIOR_CITIZEN', 'PWD')
  ),
  customer_name_ciphertext TEXT,
  customer_id_type_ciphertext TEXT,
  customer_id_number_ciphertext TEXT,
  customer_id_checked INTEGER NOT NULL DEFAULT 0 CHECK (customer_id_checked IN (0, 1)),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'QR')),
  subtotal_centavos INTEGER NOT NULL CHECK (subtotal_centavos >= 0),
  vat_centavos INTEGER NOT NULL CHECK (vat_centavos >= 0),
  vat_removed_centavos INTEGER NOT NULL CHECK (vat_removed_centavos >= 0),
  senior_discount_centavos INTEGER NOT NULL CHECK (senior_discount_centavos >= 0),
  pwd_discount_centavos INTEGER NOT NULL CHECK (pwd_discount_centavos >= 0),
  amount_due_centavos INTEGER NOT NULL CHECK (amount_due_centavos >= 0),
  tax_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (cashier_user_id, request_key),
  CHECK (
    (benefit_type = 'REGULAR' AND customer_name_ciphertext IS NULL AND customer_id_type_ciphertext IS NULL AND customer_id_number_ciphertext IS NULL AND customer_id_checked = 0)
    OR (benefit_type <> 'REGULAR' AND customer_name_ciphertext IS NOT NULL AND customer_id_type_ciphertext IS NOT NULL AND customer_id_number_ciphertext IS NOT NULL AND customer_id_checked = 1)
  )
);

CREATE INDEX sales_business_date_idx ON sales(business_date, transaction_id);
CREATE INDEX sales_cashier_created_idx ON sales(cashier_user_id, created_at);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  unit_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_centavos INTEGER NOT NULL CHECK (unit_price_centavos > 0),
  tax_class_snapshot TEXT NOT NULL CHECK (
    tax_class_snapshot IN ('VATABLE', 'VAT_EXEMPT', 'ZERO_RATED')
  ),
  sc_pwd_eligible_snapshot INTEGER NOT NULL CHECK (sc_pwd_eligible_snapshot IN (0, 1)),
  benefit_applied INTEGER NOT NULL CHECK (benefit_applied IN (0, 1)),
  tax_basis_centavos INTEGER NOT NULL CHECK (tax_basis_centavos >= 0),
  vat_centavos INTEGER NOT NULL CHECK (vat_centavos >= 0),
  vat_removed_centavos INTEGER NOT NULL CHECK (vat_removed_centavos >= 0),
  discount_centavos INTEGER NOT NULL CHECK (discount_centavos >= 0),
  amount_due_centavos INTEGER NOT NULL CHECK (amount_due_centavos >= 0),
  allocated_cogs_centavos INTEGER NOT NULL CHECK (allocated_cogs_centavos >= 0),
  tax_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, line_number)
);

CREATE INDEX sale_lines_sale_idx ON sale_lines(sale_id, line_number);
CREATE INDEX sale_lines_product_idx ON sale_lines(product_id, created_at);

CREATE TABLE sale_sequences (
  business_date TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);
