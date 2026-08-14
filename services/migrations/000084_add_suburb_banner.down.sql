ALTER TABLE suburb_demographics
  DROP COLUMN IF EXISTS banner_archetype, DROP COLUMN IF EXISTS banner_blurb,
  DROP COLUMN IF EXISTS banner_landmarks, DROP COLUMN IF EXISTS banner_bg_key,
  DROP COLUMN IF EXISTS banner_bg_url, DROP COLUMN IF EXISTS banner_generated_at;
