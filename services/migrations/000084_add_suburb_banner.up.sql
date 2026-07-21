ALTER TABLE suburb_demographics
  ADD COLUMN IF NOT EXISTS banner_archetype    text,
  ADD COLUMN IF NOT EXISTS banner_blurb        text,
  ADD COLUMN IF NOT EXISTS banner_landmarks    jsonb,
  ADD COLUMN IF NOT EXISTS banner_bg_key       text,
  ADD COLUMN IF NOT EXISTS banner_bg_url       text,
  ADD COLUMN IF NOT EXISTS banner_generated_at timestamptz;
