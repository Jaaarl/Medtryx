-- @requires-foreign-keys-off
CREATE TABLE sales_rebuilt (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  business_date TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shift_id TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
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
  cash_rounding_mode TEXT NOT NULL DEFAULT 'NONE'
    CHECK (cash_rounding_mode IN ('NONE', 'NEAREST_25_CENTAVOS')),
  cash_rounding_adjustment_centavos INTEGER NOT NULL DEFAULT 0
    CHECK (cash_rounding_adjustment_centavos BETWEEN -12 AND 12),
  bnpc_discount_centavos INTEGER NOT NULL DEFAULT 0
    CHECK (bnpc_discount_centavos >= 0),
  customer_birthday_ciphertext TEXT,
  customer_lookup_digest TEXT,
  UNIQUE (cashier_user_id, request_key),
  CHECK (
    (benefit_type = 'REGULAR' AND customer_name_ciphertext IS NULL AND customer_id_type_ciphertext IS NULL AND customer_id_number_ciphertext IS NULL AND customer_id_checked = 0)
    OR (benefit_type <> 'REGULAR' AND customer_name_ciphertext IS NOT NULL AND customer_id_type_ciphertext IS NOT NULL AND customer_id_number_ciphertext IS NOT NULL AND customer_id_checked = 1)
  )
);

INSERT INTO sales_rebuilt (
  id, transaction_id, business_date, request_key, request_hash,
  cashier_user_id, shift_id, benefit_type, customer_name_ciphertext,
  customer_id_type_ciphertext, customer_id_number_ciphertext,
  customer_id_checked, payment_method, subtotal_centavos, vat_centavos,
  vat_removed_centavos, senior_discount_centavos, pwd_discount_centavos,
  amount_due_centavos, tax_policy_version, created_at, cash_rounding_mode,
  cash_rounding_adjustment_centavos, bnpc_discount_centavos,
  customer_birthday_ciphertext, customer_lookup_digest
)
SELECT
  id, transaction_id, business_date, request_key, request_hash,
  cashier_user_id, shift_id, benefit_type, customer_name_ciphertext,
  customer_id_type_ciphertext, customer_id_number_ciphertext,
  customer_id_checked, payment_method, subtotal_centavos, vat_centavos,
  vat_removed_centavos, senior_discount_centavos, pwd_discount_centavos,
  amount_due_centavos, tax_policy_version, created_at, cash_rounding_mode,
  cash_rounding_adjustment_centavos, bnpc_discount_centavos,
  customer_birthday_ciphertext, customer_lookup_digest
FROM sales;

DROP TABLE sales;
ALTER TABLE sales_rebuilt RENAME TO sales;

CREATE INDEX sales_business_date_idx ON sales(business_date, transaction_id);
CREATE INDEX sales_cashier_created_idx ON sales(cashier_user_id, created_at);
CREATE INDEX sales_customer_lookup_idx
  ON sales(customer_lookup_digest, benefit_type, created_at);
