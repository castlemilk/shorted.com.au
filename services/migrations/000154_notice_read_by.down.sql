-- 000154 down: drops the read_by columns and their checks. Rows read by a model lose
-- the mark, so the parser's own rows and the model's are indistinguishable after this.
-- Rolling back the CODE is safe at any time: the API reads read_by as 'parser' when the
-- column is absent (store/shorts/postgres_ownership.go).
BEGIN;
SET LOCAL lock_timeout = '15s';

ALTER TABLE substantial_holder_notice_attempts DROP CONSTRAINT IF EXISTS substantial_holder_notice_attempts_read_by_check;
ALTER TABLE substantial_holder_notice_attempts DROP COLUMN IF EXISTS read_by;
ALTER TABLE substantial_holder_notices DROP CONSTRAINT IF EXISTS substantial_holder_notices_read_by_check;
ALTER TABLE substantial_holder_notices DROP COLUMN IF EXISTS read_by;

COMMIT;
