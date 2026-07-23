-- Health record for the Mac-based residential housing crawl so it appears as a
-- first-class SCHEDULED JOB in the admin jobs dashboard alongside the GCP Cloud
-- Run jobs.
--
-- WHY A DB TABLE: the admin dashboard (/api/admin/jobs) is populated by
-- jobmonitor.Collect(), which reads GCP Cloud Run Job executions + Cloud
-- Scheduler triggers directly — it has ZERO visibility into anything that does
-- not run on GCP. The residential crawl runs on a Mac (Kasada needs a residential
-- IP + a warm host-Chrome — it CANNOT run on Cloud Run), so it would never appear
-- there without a DB-backed source. Each scheduled crawl invocation (launchd
-- run-housing-delta.sh / run-housing-full.sh, and ad-hoc `-mode agent`) upserts
-- ONE health record here; the shorts API merges these rows into the jobs list.
--
-- LATEST-PER-(run_type,host): the PK is (run_type, host), so the row always
-- reflects the most recent run of that run-type on that rig. A launchd wrapper
-- loops `-mode agent` for several rounds per run; each round upserts, ACCUMULATING
-- its counts into the same row for the run (keyed by run_id) and refreshing
-- finished_at=now(). A DEAD RIG stops writing, so finished_at goes stale and the
-- dashboard flips the row to warning/critical automatically (see the API's
-- crawl-health derivation).

CREATE TABLE IF NOT EXISTS crawl_run_status (
    run_type                TEXT NOT NULL,            -- 'delta' | 'full' | 'agent'
    host                    TEXT NOT NULL,            -- os.Hostname() of the rig
    run_id                  TEXT,                     -- stable per launchd run (CRAWL_RUN_ID); rounds sharing it accumulate
    started_at              TIMESTAMPTZ,              -- first round's start for this run
    finished_at             TIMESTAMPTZ,              -- latest round's finish (freshness signal for dead-rig detection)
    status                  TEXT,                     -- 'ok' | 'blocked' | 'rewarm' | 'partial' | 'error'
    suburbs_selected        INT     NOT NULL DEFAULT 0,
    suburbs_done            INT     NOT NULL DEFAULT 0,
    listings_touched        INT     NOT NULL DEFAULT 0,
    events_written          INT     NOT NULL DEFAULT 0,
    blocked_count           INT     NOT NULL DEFAULT 0,
    rewarm_needed           BOOLEAN NOT NULL DEFAULT FALSE,
    freshness_oldest_hours  NUMERIC,                  -- annotated by `-mode freshness` (oldest covered suburb age)
    detail                  TEXT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_type, host),
    CONSTRAINT crawl_run_status_run_type_chk
        CHECK (run_type IN ('delta', 'full', 'agent', 'freshness')),
    CONSTRAINT crawl_run_status_status_chk
        CHECK (status IS NULL OR status IN ('ok', 'blocked', 'rewarm', 'partial', 'error'))
);
