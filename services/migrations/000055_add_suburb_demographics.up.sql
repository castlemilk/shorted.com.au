-- Suburb demographics from ABS Census 2021 (General Community Profile, SAL level),
-- keyed by ABS SAL_CODE21. CC-BY-4.0. The authoritative AU suburb registry for the
-- housing map (every SAL suburb appears here; price is joined in via sal_code).

CREATE TABLE IF NOT EXISTS suburb_demographics (
    sal_code                 TEXT PRIMARY KEY,        -- ABS SAL_CODE21
    sal_name                 TEXT NOT NULL,
    state_code               TEXT NOT NULL,           -- 'NSW' | 'VIC' | ...
    postcode                 TEXT,
    population               INTEGER,
    median_age               NUMERIC,
    median_weekly_hhd_income NUMERIC,                 -- median weekly household income
    median_weekly_per_income NUMERIC,                 -- median weekly personal income
    median_weekly_rent       NUMERIC,
    median_monthly_mortgage  NUMERIC,
    pct_owned_outright       NUMERIC,                 -- 0..100
    pct_owned_mortgage       NUMERIC,
    pct_rented               NUMERIC,
    dwelling_count           INTEGER,
    census_year              INTEGER NOT NULL DEFAULT 2021,
    source                   TEXT NOT NULL DEFAULT 'abs_census_2021_gcp',
    source_licence           TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suburb_demographics_state ON suburb_demographics (state_code);
CREATE INDEX IF NOT EXISTS idx_suburb_demographics_name  ON suburb_demographics (sal_name);

-- Bridge existing priced regions (house_price_regions) to their SAL suburb.
ALTER TABLE house_price_regions ADD COLUMN IF NOT EXISTS sal_code TEXT;
CREATE INDEX IF NOT EXISTS idx_house_price_regions_sal ON house_price_regions (sal_code);
