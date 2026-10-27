-- 000151: the cursor and the single-flight lease for `-mode crawl-finalize` (S-SRV).
--
-- crawl-finalize runs every 30 minutes on the server. It does the sal-linking, the
-- housing MV refresh and one cache bust, but only when the ingest has written something
-- since its last successful run:
--
--   crawl_finalize_state   the watermark: the newest crawl_ingest_receipts.created_at a
--                          finalize covered, held at least 10 minutes behind its run start
--                          (a push commits after its receipt's created_at). One row per
--                          named cursor. A missing row means "never finalized".
--   crawl_finalize_lease   one row per lease name, claimed with INSERT … ON CONFLICT DO
--                          UPDATE WHERE expires_at < now(), the same shape as
--                          picks_run_lease (000132). It keeps overlapping runs
--                          single-flight. A row, not an advisory lock, because the
--                          server's DATABASE_URL is the transaction pooler (6543).
--
-- IDEMPOTENCY
--
-- Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). CREATE TABLE IF NOT EXISTS touches no rows and
-- takes no lock on existing data, and this file writes no row.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS crawl_finalize_state (
    name        TEXT PRIMARY KEY,
    watermark   TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crawl_finalize_lease (
    name        TEXT PRIMARY KEY,
    holder      TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);

COMMIT;
