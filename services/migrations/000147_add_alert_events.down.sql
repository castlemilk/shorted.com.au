-- Reverting drops the alert delivery record and the evaluator's state. Alerts
-- already emailed are not recalled. The rows are a delivery log, not a source
-- the product needs to read back. Roll back only with the API and job images
-- that predate this table, because the current ones select it.
DROP INDEX IF EXISTS idx_alert_evaluator_runs_started;
DROP INDEX IF EXISTS idx_alert_events_delivery_queue;
DROP INDEX IF EXISTS idx_alert_events_user_report;
DROP TABLE IF EXISTS alert_evaluator_runs;
DROP TABLE IF EXISTS alert_evaluator_state;
DROP TABLE IF EXISTS alert_events;
