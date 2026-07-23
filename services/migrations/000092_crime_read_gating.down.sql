-- Restore the exact ungated 000090 crime snapshot shape. The base crime table
-- and its collector-owned refresh wiring remain in place.
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

-- Restore the 000090 shared refresh definition (the crime MV still exists).
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
