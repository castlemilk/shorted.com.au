-- Revert 000083: drop the state/agency rollups and restore the 000076
-- definition of mv_suburb_price_drops + the 000077 refresh function.

DROP MATERIALIZED VIEW IF EXISTS mv_agency_stats;
DROP MATERIALIZED VIEW IF EXISTS mv_state_price_drops;

DROP MATERIALIZED VIEW IF EXISTS mv_suburb_price_drops;
CREATE MATERIALIZED VIEW mv_suburb_price_drops AS
WITH win AS (
    SELECT DISTINCT ON (listing_pk)
        region_code, listing_pk, drop_pct, drop_abs
    FROM property_price_events
    WHERE event_type = 'price_drop'
      AND observed_at >= now() - interval '30 days'
      AND drop_pct IS NOT NULL
    ORDER BY listing_pk, drop_pct DESC
), agg AS (
    SELECT region_code,
        COUNT(*)                                               AS dropped_listing_count,
        AVG(drop_pct)                                          AS avg_drop_pct,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY drop_pct)  AS median_drop_pct,
        MAX(drop_pct)                                          AS max_drop_pct,
        MAX(drop_abs)                                          AS max_drop_abs
    FROM win
    GROUP BY region_code
), active AS (
    SELECT region_code, COUNT(*) AS total_active_listings
    FROM property_listings
    WHERE is_active
    GROUP BY region_code
)
SELECT a.region_code,
       a.dropped_listing_count,
       a.avg_drop_pct,
       a.median_drop_pct,
       a.max_drop_pct,
       a.max_drop_abs,
       COALESCE(ac.total_active_listings, 0) AS total_active_listings,
       a.dropped_listing_count::float / NULLIF(ac.total_active_listings, 0) AS dropped_share
FROM agg a
LEFT JOIN active ac USING (region_code)
WHERE a.dropped_listing_count >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key
    ON mv_suburb_price_drops (region_code);

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
END;
$$ LANGUAGE plpgsql;
