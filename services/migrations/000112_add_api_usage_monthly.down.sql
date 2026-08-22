-- Reverting drops the current month's quota accounting. That is acceptable:
-- the counters are a fairness control rebuilt from live traffic, not a ledger.
DROP INDEX IF EXISTS idx_api_usage_monthly_period;
DROP TABLE IF EXISTS api_usage_monthly;
