BEGIN;

DROP TRIGGER IF EXISTS update_alert_monitors_updated_at ON alert_monitors;
DROP INDEX IF EXISTS idx_alert_monitors_active_unique;
DROP INDEX IF EXISTS idx_alert_monitors_user_scope_target;
DROP INDEX IF EXISTS idx_alert_monitors_user_status_created;
DROP INDEX IF EXISTS idx_alert_monitors_user_created;
DROP TABLE IF EXISTS alert_monitors;

COMMIT;
