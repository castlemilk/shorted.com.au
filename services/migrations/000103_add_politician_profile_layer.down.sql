-- Reverse of 000103.
--
-- The view goes first (it depends on both tables), then the triggers and their
-- functions, then the tables, then the columns.
DROP VIEW IF EXISTS politician_profile_resolved;

DROP TRIGGER IF EXISTS trg_politician_profile_overrides_field ON politician_profile_overrides;
DROP TRIGGER IF EXISTS trg_politician_profile_facts_field ON politician_profile_facts;
DROP FUNCTION IF EXISTS politician_profile_reject_field();

DROP TABLE IF EXISTS politician_profile_overrides;
DROP TABLE IF EXISTS politician_profile_facts;

DROP TRIGGER IF EXISTS trg_politicians_reject_merge_chain ON politicians;
DROP FUNCTION IF EXISTS politicians_reject_merge_chain();

ALTER TABLE politicians DROP CONSTRAINT IF EXISTS politicians_merge_needs_evidence;

DROP INDEX IF EXISTS idx_politicians_aph_phid;

ALTER TABLE politicians
    DROP COLUMN IF EXISTS merge_evidence,
    DROP COLUMN IF EXISTS merged_at,
    DROP COLUMN IF EXISTS merged_by,
    DROP COLUMN IF EXISTS aph_phid;
