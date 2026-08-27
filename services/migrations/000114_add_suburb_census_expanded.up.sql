-- Curated ABS 2021 Census GCP rates by Suburb and Locality (SAL).
-- Values remain NULL when a source table/header is absent or quality-gated.
ALTER TABLE IF EXISTS suburb_demographics
    ADD COLUMN IF NOT EXISTS pct_low_personal_income         NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_high_personal_income        NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS unemployment_rate               NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS labour_force_participation_rate NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_bachelor_or_higher          NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_separate_house              NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_flat_apartment              NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_couple_with_children        NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS pct_lone_person_household       NUMERIC(5,2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'suburb_demographics_census_expanded_pct_check'
          AND conrelid = to_regclass('suburb_demographics')
    ) AND to_regclass('suburb_demographics') IS NOT NULL THEN
        ALTER TABLE IF EXISTS suburb_demographics
            ADD CONSTRAINT suburb_demographics_census_expanded_pct_check CHECK (
                (pct_low_personal_income IS NULL OR pct_low_personal_income BETWEEN 0 AND 100) AND
                (pct_high_personal_income IS NULL OR pct_high_personal_income BETWEEN 0 AND 100) AND
                (unemployment_rate IS NULL OR unemployment_rate BETWEEN 0 AND 100) AND
                (labour_force_participation_rate IS NULL OR labour_force_participation_rate BETWEEN 0 AND 100) AND
                (pct_bachelor_or_higher IS NULL OR pct_bachelor_or_higher BETWEEN 0 AND 100) AND
                (pct_separate_house IS NULL OR pct_separate_house BETWEEN 0 AND 100) AND
                (pct_flat_apartment IS NULL OR pct_flat_apartment BETWEEN 0 AND 100) AND
                (pct_couple_with_children IS NULL OR pct_couple_with_children BETWEEN 0 AND 100) AND
                (pct_lone_person_household IS NULL OR pct_lone_person_household BETWEEN 0 AND 100)
            );
    END IF;
END
$$;
