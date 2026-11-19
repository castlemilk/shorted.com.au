-- Preserve the figures already corroborated against the source filings.
BEGIN;
SET LOCAL lock_timeout = '15s';
DROP TRIGGER IF EXISTS ownership_reviewed_votes ON substantial_holder_notices;
DROP FUNCTION IF EXISTS ownership_apply_reviewed_votes();
DROP TABLE IF EXISTS ownership_reviewed_holder_votes;
COMMIT;
