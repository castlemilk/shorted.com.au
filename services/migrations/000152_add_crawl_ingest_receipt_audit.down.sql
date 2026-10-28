-- Reverting drops the two audit columns and the receipts they describe. Rolling back
-- the CODE is safe at any time: the ingest falls back to the receipt insert without
-- these columns when they are absent (see store.go insertReceiptTx).
BEGIN;
SET LOCAL lock_timeout = '15s';

ALTER TABLE crawl_ingest_receipts DROP COLUMN IF EXISTS jwt_jti;
ALTER TABLE crawl_ingest_receipts DROP COLUMN IF EXISTS jwt_kid;

COMMIT;
