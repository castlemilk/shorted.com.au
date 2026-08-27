ALTER TABLE IF EXISTS suburb_demographics
    DROP CONSTRAINT IF EXISTS suburb_demographics_seifa_deciles_check;

ALTER TABLE IF EXISTS suburb_demographics
    DROP COLUMN IF EXISTS seifa_irsd_score,
    DROP COLUMN IF EXISTS seifa_irsd_decile_aus,
    DROP COLUMN IF EXISTS seifa_irsd_decile_state,
    DROP COLUMN IF EXISTS seifa_irsad_score,
    DROP COLUMN IF EXISTS seifa_irsad_decile_aus,
    DROP COLUMN IF EXISTS seifa_irsad_decile_state,
    DROP COLUMN IF EXISTS seifa_ier_score,
    DROP COLUMN IF EXISTS seifa_ier_decile_aus,
    DROP COLUMN IF EXISTS seifa_ier_decile_state,
    DROP COLUMN IF EXISTS seifa_ieo_score,
    DROP COLUMN IF EXISTS seifa_ieo_decile_aus,
    DROP COLUMN IF EXISTS seifa_ieo_decile_state;
