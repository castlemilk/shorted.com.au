-- Reverse of 000101.
--
-- The alias resolution CHECK is narrowed back BEFORE anything else, and any row
-- already curated as 'foreign' is rewritten to not_a_security rather than
-- dropped: a human made that decision, and losing it would put the candidate
-- back in the queue for someone to decide again. It is a less precise label, not
-- a wrong one — a foreign listing is not an ASX security either way.
UPDATE register_security_aliases
   SET resolution = 'not_a_security',
       note = btrim(note || ' [down-migrated from resolution=foreign]')
 WHERE resolution = 'foreign';

ALTER TABLE register_security_aliases
    DROP CONSTRAINT IF EXISTS register_security_aliases_resolution_check;
ALTER TABLE register_security_aliases
    ADD CONSTRAINT register_security_aliases_resolution_check
        CHECK (resolution IN ('resolved', 'unlisted_fund', 'not_a_security'));

DROP INDEX IF EXISTS idx_register_items_suppressed;

-- Dropping these loses the record of which rows were withheld and why. That is
-- the correct behaviour for a down migration (the column cannot survive its own
-- removal), and it is the reason a suppression is also recorded in the takedown
-- log kept outside the database.
ALTER TABLE register_declared_items
    DROP COLUMN IF EXISTS suppression_note,
    DROP COLUMN IF EXISTS suppressed_by,
    DROP COLUMN IF EXISTS suppressed_at;

DROP TABLE IF EXISTS register_review_skips;

DROP VIEW IF EXISTS register_review_security_queue;
