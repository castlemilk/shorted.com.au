-- Reverting drops the ingest tables and the three columns.
--
-- Rolling back the CODE is safe at any time: the collector does not reference these
-- columns, and the ingest is off unless HOUSING_INGEST_ENABLED is set.
--
-- Rolling back the SCHEMA is destructive for the ingest and nothing else. It drops
-- the receipts (the replay record for every applied push), the quarantine rows, the
-- dispatch ledger, the rig enable flags and the bypass releases, and it drops the
-- receipt stamps on listing and event rows. Before running it: set
-- HOUSING_INGEST_ENABLED=false everywhere, and confirm no rig is still pushing.
BEGIN;
SET LOCAL lock_timeout = '15s';

ALTER TABLE property_price_events DROP COLUMN IF EXISTS ingest_receipt_key;
ALTER TABLE property_listings DROP COLUMN IF EXISTS last_missed_at;
ALTER TABLE property_listings DROP COLUMN IF EXISTS ingest_receipt_key;

DROP TABLE IF EXISTS crawl_ingest_quarantine_bypass;
DROP TABLE IF EXISTS crawl_ingest_quarantine;
DROP TABLE IF EXISTS housing_ingest_rigs;
DROP TABLE IF EXISTS crawl_ingest_receipts;
DROP TABLE IF EXISTS crawl_dispatch;

COMMIT;
