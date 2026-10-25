BEGIN;

SET LOCAL lock_timeout = '15s';

DROP TABLE IF EXISTS alert_email_suppressions;

-- Rolling back: the states the 000147 CHECK does not admit are folded into
-- `failed` first, so the narrower constraint can be restored.
UPDATE alert_events
   SET email_status = 'failed', updated_at = now()
 WHERE email_status IN ('bounced', 'complained', 'skipped_suppressed');

ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_email_status_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_email_status_check CHECK (email_status IN
    ('pending', 'sending', 'sent', 'failed', 'skipped_unentitled', 'skipped_no_email', 'skipped_paused',
     'awaiting_entitlement'));

COMMIT;
