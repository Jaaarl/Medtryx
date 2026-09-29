ALTER TABLE products
  ADD COLUMN bnpc_eligible INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_eligible IN (0, 1));
ALTER TABLE products
  ADD COLUMN bnpc_category TEXT CHECK (
    bnpc_category IS NULL OR bnpc_category IN ('BASIC_NECESSITY', 'PRIME_COMMODITY')
  );
ALTER TABLE products ADD COLUMN bnpc_source TEXT;
ALTER TABLE products ADD COLUMN bnpc_review_reference TEXT;
ALTER TABLE products ADD COLUMN bnpc_reviewed_at TEXT;
ALTER TABLE products ADD COLUMN bnpc_reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN bnpc_prescription_required INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_prescription_required IN (0, 1));

CREATE TABLE bnpc_policy_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE CHECK (length(trim(version)) BETWEEN 3 AND 64),
  effective_from TEXT NOT NULL CHECK (length(effective_from) = 10),
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reviewed_at TEXT NOT NULL CHECK (length(reviewed_at) = 10),
  discount_rate_basis_points INTEGER NOT NULL CHECK (discount_rate_basis_points BETWEEN 1 AND 10000),
  weekly_purchase_limit_centavos INTEGER NOT NULL CHECK (weekly_purchase_limit_centavos > 0),
  weekly_discount_limit_centavos INTEGER NOT NULL CHECK (weekly_discount_limit_centavos > 0),
  no_carryover INTEGER NOT NULL CHECK (no_carryover IN (0, 1)),
  minimum_kinds_at_purchase_limit INTEGER NOT NULL CHECK (minimum_kinds_at_purchase_limit >= 1),
  centavo_rule TEXT NOT NULL CHECK (centavo_rule = 'TAX_POLICY_ROUNDING_V1'),
  vat_rule TEXT NOT NULL CHECK (vat_rule = 'NORMAL_VAT_ON_DISCOUNTED_GROSS_V1'),
  promotion_rule TEXT NOT NULL CHECK (promotion_rule = 'MORE_FAVORABLE_NO_STACK_V1'),
  four_kind_evidence_rule TEXT NOT NULL CHECK (four_kind_evidence_rule = 'BOOKLET_CONFIRMATION_V1'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  store_eligibility_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (store_eligibility_confirmed IN (0, 1)),
  approval_reference TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (enabled = 0 OR (store_eligibility_confirmed = 1 AND length(trim(coalesce(approval_reference, ''))) >= 3 AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);

INSERT INTO bnpc_policy_versions
  (id, version, effective_from, source_title, source_url, reviewed_at,
   discount_rate_basis_points, weekly_purchase_limit_centavos,
   weekly_discount_limit_centavos, no_carryover,
   minimum_kinds_at_purchase_limit, centavo_rule, vat_rule,
   promotion_rule, four_kind_evidence_rule, enabled,
   store_eligibility_confirmed, approval_reference, approved_by_user_id,
   approved_at, created_by_user_id, created_at)
VALUES
  ('BNPC-JAO-24-02-INITIAL', 'JAO-DTI-DA-DOE-24-02-2024', '2024-03-25',
   'DTI-DA-DOE Joint Administrative Order No. 24-02, Series of 2024',
   'https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf',
   '2026-09-30', 500, 250000, 12500, 1, 4,
   'TAX_POLICY_ROUNDING_V1', 'NORMAL_VAT_ON_DISCOUNTED_GROSS_V1',
   'MORE_FAVORABLE_NO_STACK_V1', 'BOOKLET_CONFIRMATION_V1',
   0, 0, NULL, NULL, NULL, NULL, '2026-09-30T00:00:00.000Z');

INSERT INTO settings (key, value_json, updated_at, updated_by)
VALUES ('bnpc-policy-version', '{"versionId":"BNPC-JAO-24-02-INITIAL"}',
        '2026-09-30T00:00:00.000Z', NULL);

CREATE TRIGGER bnpc_policy_versions_no_update
BEFORE UPDATE ON bnpc_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'bnpc_policy_versions_are_immutable');
END;
CREATE TRIGGER bnpc_policy_versions_no_delete
BEFORE DELETE ON bnpc_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'bnpc_policy_versions_are_immutable');
END;

ALTER TABLE sales ADD COLUMN bnpc_discount_centavos INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_discount_centavos >= 0);
ALTER TABLE sale_lines ADD COLUMN benefit_treatment_snapshot TEXT NOT NULL DEFAULT 'REGULAR'
  CHECK (benefit_treatment_snapshot IN ('REGULAR', 'SENIOR_CITIZEN', 'PWD', 'BNPC'));
UPDATE sale_lines
SET benefit_treatment_snapshot = CASE
  WHEN benefit_applied = 1 THEN (
    SELECT benefit_type FROM sales WHERE sales.id = sale_lines.sale_id
  )
  ELSE 'REGULAR'
END;
ALTER TABLE sale_lines ADD COLUMN bnpc_eligible_snapshot INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_eligible_snapshot IN (0, 1));
ALTER TABLE sale_lines ADD COLUMN bnpc_category_snapshot TEXT;
ALTER TABLE sale_lines ADD COLUMN bnpc_discount_centavos INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_discount_centavos >= 0);
ALTER TABLE sale_lines ADD COLUMN bnpc_policy_version TEXT;
ALTER TABLE sale_lines ADD COLUMN bnpc_prescription_required_snapshot INTEGER NOT NULL DEFAULT 0
  CHECK (bnpc_prescription_required_snapshot IN (0, 1));
ALTER TABLE sale_bundle_component_snapshots ADD COLUMN benefit_treatment_snapshot TEXT
  CHECK (benefit_treatment_snapshot IS NULL OR benefit_treatment_snapshot IN ('REGULAR', 'SENIOR_CITIZEN', 'PWD', 'BNPC'));

CREATE TABLE sale_bnpc_snapshots (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  bnpc_policy_version_id TEXT NOT NULL REFERENCES bnpc_policy_versions(id) ON DELETE RESTRICT,
  holder_type TEXT NOT NULL CHECK (holder_type IN ('SENIOR_CITIZEN', 'PWD')),
  holder_key_hmac TEXT NOT NULL CHECK (length(holder_key_hmac) = 64),
  week_start_date TEXT NOT NULL CHECK (length(week_start_date) = 10),
  local_purchase_before_centavos INTEGER NOT NULL CHECK (local_purchase_before_centavos >= 0),
  local_discount_before_centavos INTEGER NOT NULL CHECK (local_discount_before_centavos >= 0),
  external_purchase_attested_centavos INTEGER NOT NULL CHECK (external_purchase_attested_centavos >= 0),
  external_discount_attested_centavos INTEGER NOT NULL CHECK (external_discount_attested_centavos >= 0),
  verified_purchase_allowance_centavos INTEGER NOT NULL CHECK (verified_purchase_allowance_centavos >= 0),
  verified_discount_allowance_centavos INTEGER NOT NULL CHECK (verified_discount_allowance_centavos >= 0),
  local_purchase_applied_centavos INTEGER NOT NULL CHECK (local_purchase_applied_centavos >= 0),
  bnpc_discount_centavos INTEGER NOT NULL CHECK (bnpc_discount_centavos >= 0),
  booklet_checked INTEGER NOT NULL CHECK (booklet_checked IN (0, 1)),
  representative_purchase INTEGER NOT NULL CHECK (representative_purchase IN (0, 1)),
  representative_documents_checked INTEGER NOT NULL CHECK (representative_documents_checked IN (0, 1)),
  authorization_letter_issued_date TEXT,
  prescription_applicable INTEGER NOT NULL CHECK (prescription_applicable IN (0, 1)),
  prescription_checked INTEGER NOT NULL CHECK (prescription_checked IN (0, 1)),
  four_kinds_checked INTEGER NOT NULL CHECK (four_kinds_checked IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX sale_bnpc_snapshots_holder_week_idx
  ON sale_bnpc_snapshots(holder_key_hmac, week_start_date);

CREATE TABLE bnpc_usage_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  holder_key_hmac TEXT NOT NULL CHECK (length(holder_key_hmac) = 64),
  week_start_date TEXT NOT NULL CHECK (length(week_start_date) = 10),
  event_type TEXT NOT NULL CHECK (event_type IN ('SALE', 'REVERSAL')),
  sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
  reversal_id TEXT REFERENCES sale_reversals(id) ON DELETE RESTRICT,
  qualifying_purchase_delta_centavos INTEGER NOT NULL,
  bnpc_discount_delta_centavos INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (event_type = 'SALE' AND sale_id IS NOT NULL AND reversal_id IS NULL AND qualifying_purchase_delta_centavos >= 0 AND bnpc_discount_delta_centavos >= 0)
    OR (event_type = 'REVERSAL' AND sale_id IS NOT NULL AND reversal_id IS NOT NULL AND qualifying_purchase_delta_centavos <= 0 AND bnpc_discount_delta_centavos <= 0)
  )
);

CREATE INDEX bnpc_usage_events_holder_week_idx
  ON bnpc_usage_events(holder_key_hmac, week_start_date, sequence);

CREATE TRIGGER sale_bnpc_snapshots_no_update
BEFORE UPDATE ON sale_bnpc_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bnpc_snapshots_are_immutable');
END;
CREATE TRIGGER sale_bnpc_snapshots_no_delete
BEFORE DELETE ON sale_bnpc_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sale_bnpc_snapshots_are_immutable');
END;
CREATE TRIGGER bnpc_usage_events_no_update
BEFORE UPDATE ON bnpc_usage_events
BEGIN
  SELECT RAISE(ABORT, 'bnpc_usage_events_are_append_only');
END;
CREATE TRIGGER bnpc_usage_events_no_delete
BEFORE DELETE ON bnpc_usage_events
BEGIN
  SELECT RAISE(ABORT, 'bnpc_usage_events_are_append_only');
END;
