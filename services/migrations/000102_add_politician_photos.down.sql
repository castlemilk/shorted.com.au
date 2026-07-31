-- Reverse of 000102.
--
-- The constraint goes first: dropping the columns it references would fail
-- while it exists.
ALTER TABLE politicians
    DROP CONSTRAINT IF EXISTS politicians_photo_needs_attribution;

DROP INDEX IF EXISTS idx_politicians_with_photo;

ALTER TABLE politicians
    DROP COLUMN IF EXISTS photo_fetched_at,
    DROP COLUMN IF EXISTS photo_entity_id,
    DROP COLUMN IF EXISTS photo_source_url,
    DROP COLUMN IF EXISTS photo_author,
    DROP COLUMN IF EXISTS photo_licence,
    DROP COLUMN IF EXISTS photo_url;
