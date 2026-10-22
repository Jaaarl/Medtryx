CREATE TABLE monthly_incentive_months (
  month TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Preserve the existing goal tiers as this month's starting configuration.
INSERT INTO monthly_incentive_months (month, value_json, updated_at, updated_by)
SELECT strftime('%Y-%m', 'now', '+8 hours'), value_json, updated_at, updated_by
FROM settings
WHERE key = 'monthly_incentive';
