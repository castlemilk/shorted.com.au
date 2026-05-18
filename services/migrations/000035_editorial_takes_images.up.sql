-- Image assets for Shorted Take editorials. Populated by the image-gen
-- pipeline (scripts/image-gen) which writes gpt-image-1 PNGs to GCS
-- and returns public URLs.
--
-- hero_image_url is the primary 16:9 banner shown above the headline
-- on /news/[slug] and used as the OG card for X / social previews.
--
-- inline_images is an ordered JSONB array of additional illustrations
-- placed inline within the body. Shape:
--   [{ "url": "https://...", "topic": "...", "alt": "..." }, ...]
-- Empty array (default) = body has no inline images.

ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS hero_image_url TEXT,
  ADD COLUMN IF NOT EXISTS inline_images JSONB NOT NULL DEFAULT '[]'::jsonb;
