-- Rebuild mv_suburb_crime_latest as the GATED read snapshot. The read path
-- MUST NOT surface quarantined rows: small_pop (ERP < 2000 -> volatile rates,
-- e.g. 399,000/100k at rank 100) and unreliable (CVS state anchor RSE > 25%).
-- Baking the gate into the MV makes it structurally impossible for a reader
-- to forget it; population + the (now constant-false) flags are exposed so
-- readers can re-assert the gate and tooltips can show the ERP denominator.
-- DROP+CREATE also makes the prod MV shape deterministic (000090 was
-- hand-applied to prod; the committed version lacks unreliable/population).
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_crime_latest;
CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
SELECT DISTINCT ON (sal_code, crime_type)
       sal_code, crime_type, fy_ending, rate_per_100k, pct_rank,
       population, small_pop, unreliable,
       source_jurisdiction, source, source_licence
FROM suburb_crime_stats
WHERE pooled AND pct_rank IS NOT NULL
  AND NOT small_pop AND NOT unreliable
  AND source_licence <> 'wa-tou-noncommercial'
ORDER BY sal_code, crime_type, fy_ending DESC;

-- Required for REFRESH ... CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_crime_latest
    ON mv_suburb_crime_latest (sal_code, crime_type);

-- Keep crime data current when the collector invokes the shared housing
-- refresh. The guarded CONCURRENTLY -> blocking fallback mirrors 000090 and
-- protects first-run or index-invalid states.
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
