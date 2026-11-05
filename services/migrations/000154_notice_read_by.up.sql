-- 000154: who read each substantial holding notice (spec 2.3, coverage programme).
--
-- The parser withholds a notice it cannot read (no_text, no_voting_power, no_holder).
-- The model pass (financial-report-extractor, notice_direct.py) reads some of those a
-- second time, under the extractor's consensus and the parser's own validation, and
-- stores what it recovers with read_by = 'model'. Everything the parser stores is
-- read_by = 'parser', which is also the default, so every existing row reads as before.
--
-- The number is 000154, not 000145 as the coverage spec first named it: 000145 is
-- chat_usage_events, already applied and allowlisted, and migration_versions_are_unique
-- refuses two up files with one version.
--
-- Replay-safe, as every migration in the deploy allowlist must be
-- (.github/workflows/terraform-deploy.yml):
--
--   * Each column is added only when the catalog lacks it, by a guarded DO block, so a
--     replay takes no lock on a table the API reads. ALTER TABLE takes ACCESS EXCLUSIVE
--     even for ADD COLUMN IF NOT EXISTS, which is why the catalog check comes first.
--   * A constant DEFAULT on PostgreSQL 11 and later is a catalog-only change: the table
--     is not rewritten and no row is read or written.
--   * Each CHECK is added only when absent. The rows hold only 'parser' or 'model'
--     (the write path sets nothing else), so validating it reads the table once.
--
-- The lock is bounded by lock_timeout, so a blocked ALTER fails the step before any
-- image is swapped.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $m154$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('substantial_holder_notices') AND attname = 'read_by' AND NOT attisdropped
  ) THEN
    ALTER TABLE substantial_holder_notices ADD COLUMN IF NOT EXISTS read_by TEXT NOT NULL DEFAULT 'parser';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('substantial_holder_notices') AND conname = 'substantial_holder_notices_read_by_check'
  ) THEN
    ALTER TABLE substantial_holder_notices
      ADD CONSTRAINT substantial_holder_notices_read_by_check CHECK (read_by IN ('parser', 'model'));
  END IF;
END
$m154$;

DO $m154a$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('substantial_holder_notice_attempts') AND attname = 'read_by' AND NOT attisdropped
  ) THEN
    ALTER TABLE substantial_holder_notice_attempts ADD COLUMN IF NOT EXISTS read_by TEXT NOT NULL DEFAULT 'parser';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('substantial_holder_notice_attempts') AND conname = 'substantial_holder_notice_attempts_read_by_check'
  ) THEN
    ALTER TABLE substantial_holder_notice_attempts
      ADD CONSTRAINT substantial_holder_notice_attempts_read_by_check CHECK (read_by IN ('parser', 'model'));
  END IF;
END
$m154a$;

COMMIT;
