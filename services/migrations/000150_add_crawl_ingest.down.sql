-- Reverting drops the ingest tables and the three columns. Roll back only the
-- services image that predates the ingest (the code selects last_missed_at and
-- writes ingest_receipt_key only when HOUSING_INGEST_ENABLED is set, but the
-- collector writes both columns unconditionally once this migration is applied).
-- Dropping ingest_receipt_key discards the receipt stamps, so a revert after a
-- live ingest has no surgical rollback left.
BEGIN;
SET LOCAL lock_timeout = '15s';

ALTER TABLE property_price_events DROP COLUMN IF EXISTS ingest_receipt_key;
ALTER TABLE property_listings DROP COLUMN IF EXISTS last_missed_at;
ALTER TABLE property_listings DROP COLUMN IF EXISTS ingest_receipt_key;

DROP TABLE IF EXISTS crawl_ingest_quarantine;
DROP TABLE IF EXISTS housing_ingest_rigs;
DROP TABLE IF EXISTS crawl_ingest_receipts;
DROP TABLE IF EXISTS crawl_dispatch;

COMMIT;
