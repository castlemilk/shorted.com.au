-- Per-suburb hazard exposure: measured area shares of each SAL suburb inside a
-- statutory hazard overlay or observed under water by satellite. Its own table
-- rather than more suburb_demographics columns because every share carries its
-- own source and refresh cadence, and because the unlicensed state must be
-- unstorable: source_licence has a DEFAULT and a CHECK, so a row cannot exist
-- without an open licence.
--
-- Replay-safe on purpose (every statement IF NOT EXISTS, no rows touched), so
-- it can sit on the deploy allowlist without harm. NULL means "no source covers
-- this suburb" — a genuine 0 is stored as 0.
CREATE TABLE IF NOT EXISTS suburb_hazard_exposure (
  sal_code                  TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code) ON DELETE CASCADE,
  -- DEA Water Observations Statistics (Landsat, 1987 onward), 30 m.
  water_observed_share_pct  DOUBLE PRECISION,
  permanent_water_share_pct DOUBLE PRECISION,
  water_sampled_cells       INTEGER,
  water_source              TEXT,
  -- Statutory flood planning overlay (NSW EPI Flood; VIC LSIO/FO/SBO).
  flood_planning_share_pct  DOUBLE PRECISION,
  flood_source              TEXT,
  -- Bushfire prone land (NSW BFPL; VIC BMO).
  bushfire_prone_share_pct  DOUBLE PRECISION,
  bushfire_source           TEXT,
  source_licence            TEXT NOT NULL DEFAULT 'CC-BY-4.0',
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suburb_hazard_exposure_share_bounds_check CHECK (
    (water_observed_share_pct IS NULL OR water_observed_share_pct BETWEEN 0 AND 100)
    AND (permanent_water_share_pct IS NULL OR permanent_water_share_pct BETWEEN 0 AND 100)
    AND (flood_planning_share_pct IS NULL OR flood_planning_share_pct BETWEEN 0 AND 100)
    AND (bushfire_prone_share_pct IS NULL OR bushfire_prone_share_pct BETWEEN 0 AND 100)
  ),
  CONSTRAINT suburb_hazard_exposure_licence_check CHECK (
    source_licence <> 'proprietary-tos-restricted'
  )
);

CREATE INDEX IF NOT EXISTS idx_suburb_hazard_exposure_flood
  ON suburb_hazard_exposure (flood_planning_share_pct)
  WHERE flood_planning_share_pct IS NOT NULL;
