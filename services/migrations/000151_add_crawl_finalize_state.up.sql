-- 000151: the cursor for `-mode crawl-finalize` (S-SRV).
--
-- crawl-finalize runs every 30 minutes on the server. It does the sal-linking, the
-- housing MV refresh and one cache bust, but only when the fleet's ingest has
-- written something since its last successful run. This table holds that
-- watermark: the newest crawl_ingest_receipts.created_at a finalize covered.
--
-- One row per named cursor. The job uses name = 'crawl-finalize'. A missing row
-- means "never finalized", so the first run after deploy finalizes everything once.
--
-- IDEMPOTENCY
--
-- Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). CREATE TABLE IF NOT EXISTS touches no
-- rows and takes no lock on existing data, and this file writes no row.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS crawl_finalize_state (
    name        TEXT PRIMARY KEY,
    watermark   TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
