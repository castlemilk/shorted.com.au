-- Per-suburb amenity counts, nearest-distances, and derived lifestyle indices,
-- keyed by ABS SAL_CODE21. OSM-derived columns are aggregate counts (a Produced
-- Work under ODbL — attribution only, no share-alike); raw OSM points are never
-- stored. School location/sector/type is ACARA CC-BY; rail/health/coast are
-- Geoscience Australia CC-BY. See the design doc §7.
CREATE TABLE IF NOT EXISTS suburb_amenities (
    sal_code               TEXT PRIMARY KEY,
    schools_total          INTEGER,
    schools_primary        INTEGER,
    schools_secondary      INTEGER,
    schools_gov            INTEGER,
    schools_catholic       INTEGER,
    schools_independent    INTEGER,
    nearest_secondary_km   NUMERIC,
    supermarkets_total     INTEGER,
    coles_count            INTEGER,
    woolworths_count       INTEGER,
    aldi_count             INTEGER,
    iga_count              INTEGER,
    nearest_supermarket_km NUMERIC,
    pubs_bars              INTEGER,
    clubs                  INTEGER,
    parks_count            INTEGER,
    green_space_ratio      NUMERIC,      -- park area ÷ suburb land area, 0..1
    libraries_count        INTEGER,
    nearest_train_km       NUMERIC,
    hospitals_count        INTEGER,
    gp_count               INTEGER,
    pharmacy_count         INTEGER,
    nearest_hospital_km    NUMERIC,
    dist_to_coast_km       NUMERIC,
    grocery_access_score   NUMERIC,      -- 0..100 derived
    amenity_density_score  NUMERIC,      -- 0..100 derived
    walkability_score      NUMERIC,      -- 0..100 derived
    family_friendly_score  NUMERIC,      -- 0..100 derived
    osm_source_licence     TEXT NOT NULL DEFAULT 'ODbL-1.0',
    source                 TEXT,
    source_licence         TEXT,
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
