ALTER TABLE suburb_demographics
    DROP COLUMN IF EXISTS pct_born_overseas,
    DROP COLUMN IF EXISTS pct_english_only,
    DROP COLUMN IF EXISTS top_religion,
    DROP COLUMN IF EXISTS pct_top_religion,
    DROP COLUMN IF EXISTS pct_no_religion,
    DROP COLUMN IF EXISTS top_language,
    DROP COLUMN IF EXISTS pct_top_language;
