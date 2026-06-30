-- Local Government Area dimension (ABS ASGS Ed.3 LGA_2024) + suburb→LGA bridge.
-- ABS facts (name/area/population/growth/demographics) are CC-BY-4.0; the
-- financial columns (rates, sustainability ratios, mayor/councillors) are
-- per-state and licence-gated — they stay NULL until each state is cleared
-- (NSW "Your Council" is Crown copyright and must NOT be populated without
-- written OLG permission). See docs/superpowers/specs/2026-06-30-local-insights-design.md §7.
CREATE TABLE IF NOT EXISTS lga (
    lga_code24          TEXT PRIMARY KEY,        -- ABS LGA_CODE_2024
    lga_name            TEXT NOT NULL,
    state_code          TEXT NOT NULL,
    area_sqkm           NUMERIC,
    population          INTEGER,                 -- ABS ERP latest
    pop_growth_pct      NUMERIC,                 -- YoY ERP
    median_age          NUMERIC,
    median_hhd_income   INTEGER,
    pct_rented          NUMERIC,                 -- Census G37 at LGA
    aclg_group          TEXT,                    -- ACLG/OLG peer classification
    mayor               TEXT,                    -- nullable, per-state, licence-gated
    councillor_count    INTEGER,                 -- nullable
    avg_rates           NUMERIC,                 -- nullable, per-state, licence-gated
    op_surplus_ratio    NUMERIC,                 -- nullable
    asset_renewal_ratio NUMERIC,                 -- nullable
    centroid_lat        NUMERIC,
    centroid_lon        NUMERIC,
    fin_source          TEXT,                    -- financial-data provenance (per-state)
    fin_source_licence  TEXT,
    source              TEXT NOT NULL DEFAULT 'abs_asgs_2024',
    source_licence      TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lga_state ON lga (state_code);

-- A suburb can straddle multiple councils; dominant_lga is the best single
-- assignment (by mesh-block weight), overlap_lgas keeps the full list.
CREATE TABLE IF NOT EXISTS suburb_lga (
    sal_code     TEXT PRIMARY KEY,
    lga_code24   TEXT NOT NULL,
    overlap_lgas JSONB NOT NULL DEFAULT '[]'     -- [{ "lga_code24": "...", "share": 0.0 }]
);
CREATE INDEX IF NOT EXISTS idx_suburb_lga_lga ON suburb_lga (lga_code24);
