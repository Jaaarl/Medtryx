ALTER TABLE sales
  ADD COLUMN customer_lookup_digest TEXT;

CREATE INDEX sales_customer_lookup_idx
  ON sales(customer_lookup_digest, benefit_type, created_at);
