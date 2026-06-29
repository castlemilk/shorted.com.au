-- Cultural demographics for the suburb map's "highlight" toggle: religion (ABS
-- Census 2021 G14), language used at home (G13), and birthplace (G01). Religion
-- and language are discrete categories (dominant-category choropleth), so we
-- store the dominant label + its share; born-overseas and English-only are
-- continuous percentages. CC-BY-4.0, same provenance as suburb_demographics.

ALTER TABLE suburb_demographics
    ADD COLUMN IF NOT EXISTS pct_born_overseas NUMERIC,   -- 0..100 (Birthplace: Elsewhere)
    ADD COLUMN IF NOT EXISTS pct_english_only  NUMERIC,   -- 0..100 (speaks English only at home)
    ADD COLUMN IF NOT EXISTS top_religion      TEXT,      -- dominant religious affiliation label
    ADD COLUMN IF NOT EXISTS pct_top_religion  NUMERIC,   -- 0..100 share of the dominant religion
    ADD COLUMN IF NOT EXISTS pct_no_religion   NUMERIC,   -- 0..100 ("No religion, so described")
    ADD COLUMN IF NOT EXISTS top_language      TEXT,      -- top language other than English at home
    ADD COLUMN IF NOT EXISTS pct_top_language  NUMERIC;   -- 0..100 share speaking top_language
