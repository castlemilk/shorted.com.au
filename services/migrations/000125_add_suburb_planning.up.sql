-- Per-suburb planning layer: the statutory zoning mix (harmonised into ten
-- cross-state families), heritage share + listed-item count, the NSW
-- development standards over the residential-zoned part of the suburb, and the
-- planning instrument(s) that apply. Computed offline by
-- web/scripts/geo/planning/planning_share.py and loaded by
-- `house-price-collector -mode planning`.
--
-- Its own table (not more suburb_hazard_exposure columns) because planning has
-- its own sources and refresh cadence, and because the unlicensed state must be
-- unstorable: source_licence has a DEFAULT and a CHECK.
--
-- Replay-safe on purpose (every statement IF NOT EXISTS, no rows touched), so
-- it can sit on the deploy allowlist without harm. NULL means "no source covers
-- this suburb" (QLD/WA/NT zoning, controls outside NSW, a suburb the scheme
-- layers cover for under half its area); a genuine 0 is 0.
-- Family shares are % of the whole suburb and sum to zoning_coverage_pct.
CREATE TABLE IF NOT EXISTS suburb_planning (
  sal_code                        TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code) ON DELETE CASCADE,
  -- Zoning family shares (decision 8 families), % of suburb area.
  zone_res_low_share_pct          DOUBLE PRECISION,
  zone_res_medium_high_share_pct  DOUBLE PRECISION,
  zone_centre_mixed_share_pct     DOUBLE PRECISION,
  zone_industrial_share_pct       DOUBLE PRECISION,
  zone_rural_share_pct            DOUBLE PRECISION,
  zone_conservation_share_pct     DOUBLE PRECISION,
  zone_open_space_share_pct       DOUBLE PRECISION,
  zone_infrastructure_share_pct   DOUBLE PRECISION,
  zone_water_share_pct            DOUBLE PRECISION,
  zone_other_share_pct            DOUBLE PRECISION,
  -- % of the suburb covered by any zone polygon; 0 = the state's scheme does
  -- not reach this suburb (family shares are then NULL, not 0).
  zoning_coverage_pct             DOUBLE PRECISION,
  dominant_zone_family            TEXT,
  -- % of the suburb in a heritage conservation area / Heritage Overlay /
  -- historic or character area (area-type classes only; see data-sources.md).
  heritage_share_pct              DOUBLE PRECISION,
  -- Listed heritage items (places), each counted once, in the suburb holding
  -- its largest polygon. Never a location list.
  heritage_item_count             INTEGER,
  -- NSW Standard Instrument development standards over the residential-zoned
  -- part of the suburb: area-weighted median / maximum.
  nsw_height_median_m             DOUBLE PRECISION,
  nsw_height_max_m                DOUBLE PRECISION,
  nsw_fsr_median                  DOUBLE PRECISION,
  nsw_min_lot_median_m2           DOUBLE PRECISION,
  -- % of that residential land each standard is actually mapped on (0 = none).
  -- Many LEPs map FSR, and some height, only in their centres; a standard
  -- mapped on under half the residential land has no median/max (it would be
  -- the centre's number, not the suburb's) — see suburb_planning_measured_check.
  nsw_height_mapped_pct           DOUBLE PRECISION,
  nsw_fsr_mapped_pct              DOUBLE PRECISION,
  nsw_min_lot_mapped_pct          DOUBLE PRECISION,
  planning_instruments            TEXT[],
  zoning_source                   TEXT,
  heritage_source                 TEXT,
  source_licence                  TEXT NOT NULL DEFAULT 'CC-BY-4.0',
  computed_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suburb_planning_share_bounds_check CHECK (
    (zone_res_low_share_pct IS NULL OR zone_res_low_share_pct BETWEEN 0 AND 100)
    AND (zone_res_medium_high_share_pct IS NULL OR zone_res_medium_high_share_pct BETWEEN 0 AND 100)
    AND (zone_centre_mixed_share_pct IS NULL OR zone_centre_mixed_share_pct BETWEEN 0 AND 100)
    AND (zone_industrial_share_pct IS NULL OR zone_industrial_share_pct BETWEEN 0 AND 100)
    AND (zone_rural_share_pct IS NULL OR zone_rural_share_pct BETWEEN 0 AND 100)
    AND (zone_conservation_share_pct IS NULL OR zone_conservation_share_pct BETWEEN 0 AND 100)
    AND (zone_open_space_share_pct IS NULL OR zone_open_space_share_pct BETWEEN 0 AND 100)
    AND (zone_infrastructure_share_pct IS NULL OR zone_infrastructure_share_pct BETWEEN 0 AND 100)
    AND (zone_water_share_pct IS NULL OR zone_water_share_pct BETWEEN 0 AND 100)
    AND (zone_other_share_pct IS NULL OR zone_other_share_pct BETWEEN 0 AND 100)
    AND (zoning_coverage_pct IS NULL OR zoning_coverage_pct BETWEEN 0 AND 100)
    AND (heritage_share_pct IS NULL OR heritage_share_pct BETWEEN 0 AND 100)
    AND (nsw_height_mapped_pct IS NULL OR nsw_height_mapped_pct BETWEEN 0 AND 100)
    AND (nsw_fsr_mapped_pct IS NULL OR nsw_fsr_mapped_pct BETWEEN 0 AND 100)
    AND (nsw_min_lot_mapped_pct IS NULL OR nsw_min_lot_mapped_pct BETWEEN 0 AND 100)
  ),
  -- The two coverage gates (planning_share.py MIN_MEASURED_COVERAGE_PCT and
  -- CONTROL_MIN_MAPPED_PCT; planning.go mirrors both). A suburb the scheme
  -- layers cover for under half its area is mostly planned by an instrument we
  -- do not carry (The Rocks: 2.9%), so only its coverage is a measurement —
  -- "0% heritage" or a dominant family from a sliver would not be. A NULL
  -- coverage is a state with no zoning source (QLD: register items only).
  CONSTRAINT suburb_planning_measured_check CHECK (
    ((dominant_zone_family IS NULL AND heritage_share_pct IS NULL AND heritage_item_count IS NULL)
      OR zoning_coverage_pct IS NULL OR zoning_coverage_pct >= 50)
    AND (nsw_height_median_m IS NULL OR nsw_height_mapped_pct >= 50)
    AND (nsw_height_max_m IS NULL OR nsw_height_mapped_pct >= 50)
    AND (nsw_fsr_median IS NULL OR nsw_fsr_mapped_pct >= 50)
    AND (nsw_min_lot_median_m2 IS NULL OR nsw_min_lot_mapped_pct >= 50)
  ),
  CONSTRAINT suburb_planning_family_check CHECK (
    dominant_zone_family IS NULL OR dominant_zone_family IN (
      'res_low', 'res_medium_high', 'centre_mixed', 'industrial', 'rural',
      'conservation', 'open_space', 'infrastructure', 'water', 'other'
    )
  ),
  CONSTRAINT suburb_planning_controls_check CHECK (
    (heritage_item_count IS NULL OR heritage_item_count >= 0)
    AND (nsw_height_median_m IS NULL OR nsw_height_median_m > 0)
    AND (nsw_height_max_m IS NULL OR nsw_height_max_m > 0)
    AND (nsw_fsr_median IS NULL OR nsw_fsr_median > 0)
    AND (nsw_min_lot_median_m2 IS NULL OR nsw_min_lot_median_m2 > 0)
  ),
  CONSTRAINT suburb_planning_licence_check CHECK (
    source_licence <> 'proprietary-tos-restricted'
  )
);

CREATE INDEX IF NOT EXISTS idx_suburb_planning_dominant_family
  ON suburb_planning (dominant_zone_family)
  WHERE dominant_zone_family IS NOT NULL;
