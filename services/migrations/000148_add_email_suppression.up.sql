-- Resend delivery feedback for alert email: a hard bounce or a complaint marks the
-- alert_events row it belongs to, and suppresses that address from every later
-- alert send. Written by the shorts API's Resend webhook
-- (services/shorts/internal/services/shorts/resend_webhook.go) and read by the
-- `shorted alerts` sender before each send.
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml applies a
-- hardcoded allowlist and RE-RUNS IT ON EVERY DEPLOY, so every statement below is
-- replay-safe and touches no row:
--   * the CHECK is replaced only when the catalog lacks the new states, so a replay
--     takes no lock beyond the catalog reads;
--   * the table is created IF NOT EXISTS.
-- The CHECK is added NOT VALID and then validated, so the table is never scanned
-- under the ACCESS EXCLUSIVE lock that ADD CONSTRAINT would otherwise hold.

BEGIN;

SET LOCAL lock_timeout = '15s';

-- The three states a delivery can reach after the send was accepted, plus the
-- address being suppressed at send time. The list must match
-- services/pkg/alertevents.Statuses; alertevents/schema_test.go pins it.
DO $email_status$
DECLARE
    def   TEXT;
    valid BOOLEAN;
BEGIN
    SELECT pg_get_constraintdef(oid), convalidated
      INTO def, valid
      FROM pg_constraint
     WHERE conrelid = 'alert_events'::regclass
       AND conname = 'alert_events_email_status_check';

    IF def IS NULL OR def NOT LIKE '%skipped_suppressed%' THEN
        ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_email_status_check;
        ALTER TABLE alert_events ADD CONSTRAINT alert_events_email_status_check CHECK (email_status IN
            ('pending', 'sending', 'sent', 'failed', 'skipped_unentitled', 'skipped_no_email', 'skipped_paused',
             'awaiting_entitlement', 'bounced', 'complained', 'skipped_suppressed')) NOT VALID;
        valid := FALSE;
    END IF;

    IF NOT valid THEN
        ALTER TABLE alert_events VALIDATE CONSTRAINT alert_events_email_status_check;
    END IF;
END
$email_status$;

-- One row per suppressed address. The address is stored lower-cased; the reason
-- is the first event that suppressed it, and the Resend email id is kept so an
-- operator can trace it. No message body or bounce text is stored.
CREATE TABLE IF NOT EXISTS alert_email_suppressions (
    email           TEXT PRIMARY KEY,
    reason          TEXT NOT NULL,
    resend_email_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_email_suppressions_email_check CHECK (email = lower(email) AND email <> ''),
    CONSTRAINT alert_email_suppressions_reason_check CHECK (reason IN ('bounced', 'complained'))
);

COMMIT;
