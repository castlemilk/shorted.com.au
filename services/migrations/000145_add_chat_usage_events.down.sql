-- Reverting drops the per-send ledger. The counts it holds are a fairness
-- control rebuilt from live traffic, not a billing record, so nothing is lost
-- that new sends cannot recreate.
DROP INDEX IF EXISTS idx_chat_usage_events_created;
DROP INDEX IF EXISTS idx_chat_usage_events_user_created;
DROP TABLE IF EXISTS chat_usage_events;
