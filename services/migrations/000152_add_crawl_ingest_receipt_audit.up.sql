-- 000152: the token that made each ingest push, on its receipt.
--
-- crawl_ingest_receipts already records the rig (rig_subject) and the body digest. It
-- does not record which token authenticated the push, so a replayed push cannot be
-- told from the rig's own, and a forged one leaves no trace. These two columns are the
-- token's unique id (jti) and its signing key id (kid). The ingest writes them on every
-- receipt it inserts from now on; receipts written before this migration read NULL.
--
-- Replay-safe, as every migration in the deploy allowlist must be
-- (.github/workflows/terraform-deploy.yml):
--
--   * Each column is added only when the catalog lacks it, by a guarded DO block.
--     ALTER TABLE takes ACCESS EXCLUSIVE even for a no-op ADD COLUMN IF NOT EXISTS, so
--     the catalog check is what keeps a replay from queueing behind live pushes. The
--     lock is bounded by lock_timeout, so a blocked ALTER fails the step before any
--     image is swapped.
--   * The columns are nullable with no default. On PostgreSQL 11 and later that is a
--     catalog-only change: the table is not rewritten and no row is read or written.
--
-- The ingest tolerates this migration not having run yet: it falls back to the
-- receipt insert without these columns on undefined_column (42703). So a deploy that
-- lands before this file applies does not fail a push.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $m152$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('crawl_ingest_receipts')
      AND attname = 'jwt_jti' AND NOT attisdropped
  ) THEN
    ALTER TABLE crawl_ingest_receipts ADD COLUMN IF NOT EXISTS jwt_jti TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('crawl_ingest_receipts')
      AND attname = 'jwt_kid' AND NOT attisdropped
  ) THEN
    ALTER TABLE crawl_ingest_receipts ADD COLUMN IF NOT EXISTS jwt_kid TEXT;
  END IF;
END
$m152$;

COMMIT;
