-- Short-interest alert delivery: one row per monitor per evaluated report date,
-- the evaluator's watermarks, and a run log. Written by `shorted alerts`
-- (services/jobs/internal/jobs/alerts) and read by the shorts API
-- (ListAlertMonitors, ListAlertEvents).
--
-- WHY THESE TABLES EXIST
--
-- Alert monitors could be created and listed, but nothing evaluated them and
-- nothing recorded that one fired. alert_events is the record: an event is
-- created once for each (monitor, report date), its email is sent once, and the
-- row says what happened to that email.
--
-- IDEMPOTENCY IS MANDATORY, NOT DEFENSIVE STYLE
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml
-- applies a hardcoded `-f /migrations/...` allowlist and RE-RUNS IT ON EVERY
-- DEPLOY. Every statement below is therefore re-runnable and touches no row.
--
-- REPLAY MUST NOT WAIT ON THE WRITER
--
-- CREATE INDEX IF NOT EXISTS takes a SHARE lock on the table before it checks
-- the name. Each index is therefore created only when the catalog lacks it, and
-- the file runs under lock_timeout, as 000145 does. A replay that changes
-- nothing takes no lock on any table it names beyond the catalog reads.
--
-- The one foreign key references alert_monitors, which holds no rows in prod.
-- The first run adds it under that table's lock, which is instant at 0 rows.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS alert_events (
    id               BIGSERIAL PRIMARY KEY,
    monitor_id       TEXT NOT NULL REFERENCES alert_monitors(id) ON DELETE CASCADE,
    -- Denormalised so ListAlertEvents reads one index, without a join.
    user_id          TEXT NOT NULL,
    -- A snapshot of the monitor when it fired. A monitor's settings are
    -- immutable today; the snapshot keeps history readable if that changes.
    scope            TEXT NOT NULL,
    target           TEXT NOT NULL,
    condition        TEXT NOT NULL,
    threshold        DOUBLE PRECISION,
    cadence          TEXT NOT NULL,
    -- Daily: the report evaluated. Weekly: the week's last report.
    report_date      DATE NOT NULL,
    -- The previous report, or the previous week's last report.
    compared_to_date DATE NOT NULL,
    -- Stock scope only.
    latest_percent   DOUBLE PRECISION,
    previous_percent DOUBLE PRECISION,
    -- services/pkg/alertevents.Payload.
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    email_status     TEXT NOT NULL,
    email_attempts   SMALLINT NOT NULL DEFAULT 0,
    -- A status code and a Resend error name. Never an address or a response body.
    last_error       TEXT,
    resend_id        TEXT,
    send_claimed_at  TIMESTAMPTZ,
    sent_at          TIMESTAMPTZ,
    -- alert_evaluator_runs.id. No foreign key: runs are pruned.
    run_id           BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_events_monitor_report_unique UNIQUE (monitor_id, report_date),
    CONSTRAINT alert_events_email_status_check CHECK (email_status IN
        ('pending', 'sending', 'sent', 'failed', 'skipped_unentitled', 'skipped_no_email', 'skipped_paused',
         'awaiting_entitlement')),
    CONSTRAINT alert_events_cadence_check CHECK (cadence IN ('daily', 'weekly'))
);

-- The evaluator's position. The job inserts the single row itself (INSERT ...
-- ON CONFLICT DO NOTHING), so this file touches no rows.
CREATE TABLE IF NOT EXISTS alert_evaluator_state (
    id             SMALLINT PRIMARY KEY DEFAULT 1 CONSTRAINT alert_evaluator_state_singleton CHECK (id = 1),
    daily_through  DATE,
    weekly_through DATE,
    last_canary_at TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_evaluator_runs (
    id                 BIGSERIAL PRIMARY KEY,
    -- The Kubernetes Job name that ran it.
    execution          TEXT,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ,
    outcome            TEXT NOT NULL DEFAULT 'running'
                       CONSTRAINT alert_evaluator_runs_outcome_check
                       CHECK (outcome IN ('running', 'succeeded', 'degraded', 'failed')),
    -- For example 'bootstrap', 'backlog: skipped N dates', or a replay's scope.
    note               TEXT,
    daily_dates        DATE[],
    weekly_report_date DATE,
    monitors_evaluated INT NOT NULL DEFAULT 0,
    events_created     INT NOT NULL DEFAULT 0,
    emails_sent        INT NOT NULL DEFAULT 0,
    emails_retrying    INT NOT NULL DEFAULT 0,
    emails_failed      INT NOT NULL DEFAULT 0,
    skipped_unentitled INT NOT NULL DEFAULT 0,
    canary_resend_id   TEXT,
    error              TEXT
);

-- The per-user event list. Created only when the catalog lacks it.
DO $m147_idx_user$
BEGIN
    IF to_regclass('idx_alert_events_user_report') IS NULL THEN
        EXECUTE 'CREATE INDEX idx_alert_events_user_report ON alert_events (user_id, report_date DESC, id DESC)';
    END IF;
END
$m147_idx_user$;

-- The send queue. A partial index: only rows still waiting on Resend are in it.
DO $m147_idx_queue$
BEGIN
    IF to_regclass('idx_alert_events_delivery_queue') IS NULL THEN
        EXECUTE 'CREATE INDEX idx_alert_events_delivery_queue ON alert_events (created_at, id) WHERE email_status IN (''pending'', ''sending'')';
    END IF;
END
$m147_idx_queue$;

DO $m147_idx_runs$
BEGIN
    IF to_regclass('idx_alert_evaluator_runs_started') IS NULL THEN
        EXECUTE 'CREATE INDEX idx_alert_evaluator_runs_started ON alert_evaluator_runs (started_at DESC)';
    END IF;
END
$m147_idx_runs$;

-- The comment is rewritten only when its text differs, so a replay changes nothing.
DO $m147_comment$
DECLARE
    note CONSTANT TEXT := 'One row per monitor per evaluated report date. Created by shorted alerts (services/jobs/internal/jobs/alerts). The unique key makes evaluation idempotent: a re-run cannot fire the same monitor on the same date twice. email_status is the delivery state of that one email.';
BEGIN
    IF obj_description('alert_events'::regclass, 'pg_class') IS DISTINCT FROM note THEN
        EXECUTE format('COMMENT ON TABLE alert_events IS %L', note);
    END IF;
END
$m147_comment$;

COMMIT;
