BEGIN;
DROP TABLE IF EXISTS broadcasts;
DROP INDEX IF EXISTS idx_subscriptions_active;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS unsubscribed_at;
-- created_at intentionally kept (harmless, avoids data loss on re-up).
COMMIT;
