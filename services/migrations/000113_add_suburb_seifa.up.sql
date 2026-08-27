-- ABS 2021 SEIFA indexes by Suburb and Locality (SAL).
-- Values remain NULL until the annual operator-run collector has reliable data.
ALTER TABLE IF EXISTS suburb_demographics
    ADD COLUMN IF NOT EXISTS seifa_irsd_score        INTEGER,
    ADD COLUMN IF NOT EXISTS seifa_irsd_decile_aus   SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_irsd_decile_state SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_irsad_score        INTEGER,
    ADD COLUMN IF NOT EXISTS seifa_irsad_decile_aus   SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_irsad_decile_state SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_ier_score        INTEGER,
    ADD COLUMN IF NOT EXISTS seifa_ier_decile_aus   SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_ier_decile_state SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_ieo_score        INTEGER,
    ADD COLUMN IF NOT EXISTS seifa_ieo_decile_aus   SMALLINT,
    ADD COLUMN IF NOT EXISTS seifa_ieo_decile_state SMALLINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'suburb_demographics_seifa_deciles_check'
          AND conrelid = to_regclass('suburb_demographics')
    ) AND to_regclass('suburb_demographics') IS NOT NULL THEN
        ALTER TABLE IF EXISTS suburb_demographics
            ADD CONSTRAINT suburb_demographics_seifa_deciles_check CHECK (
                (seifa_irsd_decile_aus IS NULL OR seifa_irsd_decile_aus BETWEEN 1 AND 10) AND
                (seifa_irsd_decile_state IS NULL OR seifa_irsd_decile_state BETWEEN 1 AND 10) AND
                (seifa_irsad_decile_aus IS NULL OR seifa_irsad_decile_aus BETWEEN 1 AND 10) AND
                (seifa_irsad_decile_state IS NULL OR seifa_irsad_decile_state BETWEEN 1 AND 10) AND
                (seifa_ier_decile_aus IS NULL OR seifa_ier_decile_aus BETWEEN 1 AND 10) AND
                (seifa_ier_decile_state IS NULL OR seifa_ier_decile_state BETWEEN 1 AND 10) AND
                (seifa_ieo_decile_aus IS NULL OR seifa_ieo_decile_aus BETWEEN 1 AND 10) AND
                (seifa_ieo_decile_state IS NULL OR seifa_ieo_decile_state BETWEEN 1 AND 10)
            );
    END IF;
END
$$;
