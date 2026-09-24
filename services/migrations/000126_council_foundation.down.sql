-- Guarded inverse of 000126. Drops only what 000126 created; 000061's columns
-- (population, pop_growth_pct, median_age, ... overlap_lgas) stay.
DROP INDEX IF EXISTS idx_lga_series_measure_latest;
DROP TABLE IF EXISTS lga_series;

ALTER TABLE suburb_lga DROP CONSTRAINT IF EXISTS suburb_lga_dominant_share_check;
ALTER TABLE suburb_lga DROP COLUMN IF EXISTS dominant_share;

DROP INDEX IF EXISTS idx_lga_state_slug;
ALTER TABLE lga DROP CONSTRAINT IF EXISTS lga_seifa_decile_check;
ALTER TABLE lga DROP CONSTRAINT IF EXISTS lga_kind_check;
ALTER TABLE lga
    DROP COLUMN IF EXISTS avg_household_size,
    DROP COLUMN IF EXISTS median_mortgage_monthly,
    DROP COLUMN IF EXISTS median_weekly_rent,
    DROP COLUMN IF EXISTS dwellings,
    DROP COLUMN IF EXISTS seifa_irsd_decile,
    DROP COLUMN IF EXISTS seifa_irsad_decile,
    DROP COLUMN IF EXISTS website,
    DROP COLUMN IF EXISTS wikidata_qid,
    DROP COLUMN IF EXISTS erp_year,
    DROP COLUMN IF EXISTS slug,
    DROP COLUMN IF EXISTS display_name,
    DROP COLUMN IF EXISTS kind;
