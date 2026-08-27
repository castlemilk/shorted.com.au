ALTER TABLE IF EXISTS suburb_demographics
    DROP CONSTRAINT IF EXISTS suburb_demographics_census_expanded_pct_check;

ALTER TABLE IF EXISTS suburb_demographics
    DROP COLUMN IF EXISTS pct_low_personal_income,
    DROP COLUMN IF EXISTS pct_high_personal_income,
    DROP COLUMN IF EXISTS unemployment_rate,
    DROP COLUMN IF EXISTS labour_force_participation_rate,
    DROP COLUMN IF EXISTS pct_bachelor_or_higher,
    DROP COLUMN IF EXISTS pct_separate_house,
    DROP COLUMN IF EXISTS pct_flat_apartment,
    DROP COLUMN IF EXISTS pct_couple_with_children,
    DROP COLUMN IF EXISTS pct_lone_person_household;
