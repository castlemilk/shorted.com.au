-- Rollback API subscriptions schema
DROP TRIGGER IF EXISTS update_api_subscriptions_updated_at ON api_subscriptions;
DROP INDEX IF EXISTS idx_api_tokens_prefix;
DROP INDEX IF EXISTS idx_api_tokens_user_id;
DROP INDEX IF EXISTS idx_api_tokens_hash;
DROP INDEX IF EXISTS idx_api_subscriptions_status;
DROP INDEX IF EXISTS idx_api_subscriptions_stripe_customer;
DROP INDEX IF EXISTS idx_api_subscriptions_user_id;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS api_subscriptions;
