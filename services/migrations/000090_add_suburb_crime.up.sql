-- Suburb crime statistics built in-house from PRIMARY sources (ABS Crime
-- Victimisation Survey + ABS Regional Population ERP + state police open data),
-- keyed by ABS SAL_CODE21. Every input except WA is CC-BY / open-gov, so the
-- derived dataset is commercial-OK with attribution — no licence kill-switch.
--
-- Methodology (see services/house-price-collector/crime_compute.go):
--   raw_offence_count      = summed police offences/incidents for the suburb+FY.
--   scale_factor           = a per (state, crime_type, FY) multiplier that
--                            re-benchmarks each state's police total to a
--                            nationally-consistent ABS anchor:
--                              victim_estimate mode (default):
--                                CVS_victims(state,type,FY) / Σ raw_police(state)
--                              reporting_rate mode:
--                                100 / CVS_reporting_rate(state,type,FY)
--   adjusted_offence_count = raw_offence_count × scale_factor.
--   rate_per_100k          = adjusted_offence_count / ERP(FY) × 100000.
--   pct_rank               = national population-weighted percentile of the
--                            adjusted rate per (crime_type, FY, pooled):
--                              (Σ_{v: rate_v < rate_u} pop_v + 0.5·pop_u) / Σpop × 100.
--   pooled                 = true for the 2-yr-averaged series (map default);
--                            false for the single-FY series (profile trend).
-- No-data jurisdictions (TAS/NT, and WA under its non-commercial ToU) are simply
-- absent → they hatch on the map, never paint 0.

CREATE TABLE IF NOT EXISTS suburb_crime_stats (
    sal_code               TEXT     NOT NULL,   -- ABS SAL_CODE21 (bridged via sal_name/meshblock)
    crime_type             TEXT     NOT NULL,   -- 'break_ins'|'violent'|'motor_vehicle'|'property_damage'
    fy_ending              SMALLINT NOT NULL,   -- 2024 = FY2023-24
    pooled                 BOOLEAN  NOT NULL,   -- true = 2-yr pooled (map default)
    raw_offence_count      NUMERIC,             -- summed police offences/incidents (pre-scale)
    adjusted_offence_count NUMERIC,             -- raw × state CVS scale factor
    rate_per_100k          NUMERIC,             -- adjusted / ERP(FY) × 100000
    pct_rank               NUMERIC,             -- 0..100 national pop-weighted percentile (NULL if no data)
    population             INTEGER,             -- ERP(FY) used as denominator + rank weight
    scale_factor           NUMERIC,             -- state scale applied (audit/debug)
    small_pop              BOOLEAN  NOT NULL DEFAULT false, -- ERP < 2000 (volatile rate)
    unreliable             BOOLEAN  NOT NULL DEFAULT false, -- CVS RSE>25% for the state anchor
    source_jurisdiction    TEXT     NOT NULL,   -- 'NSW'|'VIC'|'QLD'|'SA'|'WA'|'ACT'
    source                 TEXT     NOT NULL,   -- 'bocsar'|'vic_csa'|'qps_ocm'|'sapol'|'wapol'|'act_policing'
    source_licence         TEXT     NOT NULL,   -- 'CC-BY-4.0'|'CC-BY-3.0-AU'|'CC-BY'|'wa-tou-noncommercial'
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sal_code, crime_type, fy_ending, pooled)
);

CREATE INDEX IF NOT EXISTS idx_suburb_crime_latest
    ON suburb_crime_stats (sal_code, pooled, fy_ending DESC);

-- Latest pooled snapshot for the map (one row per suburb × crime_type). The WA
-- gate is kept as a defensive guard even though Phase 1 never writes WA rows
-- (WA's only suburb source sits under a non-commercial ToU — see the plan §8).
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_crime_latest;
CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
SELECT DISTINCT ON (sal_code, crime_type)
       sal_code, crime_type, fy_ending, rate_per_100k, pct_rank,
       small_pop, source_jurisdiction, source_licence
FROM suburb_crime_stats
WHERE pooled AND pct_rank IS NOT NULL
  AND source_licence <> 'wa-tou-noncommercial'
ORDER BY sal_code, crime_type, fy_ending DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_crime_latest
    ON mv_suburb_crime_latest (sal_code, crime_type);

-- Fold mv_suburb_crime_latest into the shared housing refresh (guarded
-- CONCURRENTLY→blocking fallback, same pattern as 000086), else the collector's
-- refresh() silently skips it. This CREATE OR REPLACE mirrors the 000086 body
-- and appends the crime block.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_listing_stats;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_listing_stats;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_state_price_drops;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agency_stats;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_agency_stats;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_crime_latest;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_crime_latest;
    END;
END;
$$ LANGUAGE plpgsql;
