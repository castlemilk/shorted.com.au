-- 000150: the fleet-managed housing crawl's ingest tables (S-ING).
--
-- A rig pushes raw listing sweeps to CrawlIngestService, which applies them
-- through services/pkg/housingcrawl. These are the tables that service reads and
-- writes beyond the listing tables themselves:
--
--   crawl_dispatch            the dispatch ledger. Every job a rig may push for,
--                             with its canonical target. S-SRV's enqueue fills it.
--   crawl_ingest_receipts     one row per applied push, keyed by the idempotency
--                             key, with the body hash and the response to replay.
--                             Pruned after 14 days.
--   housing_ingest_rigs       the per-rig enable flag the ingest checks on every
--                             call (cached 60s in the service).
--   crawl_ingest_quarantine   sweeps the guard held back. Reasons and counts only,
--                             never listing rows.
--
-- and two columns on the listing tables:
--
--   property_listings.ingest_receipt_key      stamped on rows an ingest wrote, so a
--   property_price_events.ingest_receipt_key  bad rig's writes can be reverted by key.
--   property_listings.last_missed_at          when missed_sweeps last advanced, for
--                                             the MinDelistInterval gate.
--
-- IDEMPOTENCY AND LOCKS
--
-- Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). Every statement here is guarded:
--
--   * CREATE TABLE / CREATE INDEX use IF NOT EXISTS. They touch no rows.
--   * The columns are added only when the catalog lacks them. ALTER TABLE takes
--     ACCESS EXCLUSIVE even for a no-op IF NOT EXISTS, so the catalog guard is
--     what keeps a replay from queueing behind live crawl writes. The lock is
--     bounded by lock_timeout, so a blocked ALTER fails the step before any image
--     is swapped instead of stalling the listing tables.
--   * The added columns are nullable with no default. On PostgreSQL 11 and later
--     that is a catalog-only change: the table is NOT rewritten and no row is
--     read or written. Existing rows read NULL, which is "not written by an
--     ingest", the correct value for every row that predates this migration.
--
-- Nothing here reads or writes a listing row.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS crawl_dispatch (
    job_id      TEXT PRIMARY KEY,
    run_id      TEXT,
    selection   TEXT,
    suburb      TEXT NOT NULL,
    state       TEXT NOT NULL,
    postcode    TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT crawl_dispatch_source_chk CHECK (source IN ('rea', 'domain'))
);

CREATE TABLE IF NOT EXISTS crawl_ingest_receipts (
    key            TEXT PRIMARY KEY,
    rig_subject    TEXT NOT NULL,
    body_sha256    BYTEA NOT NULL,
    response       JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crawl_ingest_receipts_created_at
    ON crawl_ingest_receipts (created_at);

CREATE TABLE IF NOT EXISTS housing_ingest_rigs (
    subject     TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT
);

CREATE TABLE IF NOT EXISTS crawl_ingest_quarantine (
    id              BIGSERIAL PRIMARY KEY,
    receipt_key     TEXT,
    rig_subject     TEXT,
    job_id          TEXT,
    reason          TEXT NOT NULL,
    stats           JSONB,
    payload_sha256  BYTEA,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $m150_listings$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('property_listings')
      AND attname = 'ingest_receipt_key' AND NOT attisdropped
  ) THEN
    ALTER TABLE property_listings ADD COLUMN IF NOT EXISTS ingest_receipt_key TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('property_listings')
      AND attname = 'last_missed_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE property_listings ADD COLUMN IF NOT EXISTS last_missed_at TIMESTAMPTZ;
  END IF;
END
$m150_listings$;

DO $m150_events$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('property_price_events')
      AND attname = 'ingest_receipt_key' AND NOT attisdropped
  ) THEN
    ALTER TABLE property_price_events ADD COLUMN IF NOT EXISTS ingest_receipt_key TEXT;
  END IF;
END
$m150_events$;

COMMIT;
