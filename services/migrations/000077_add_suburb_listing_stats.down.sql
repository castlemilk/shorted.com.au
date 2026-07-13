-- Restore the housing refresh to the 000076 (drops-only) body, then drop the stats MV.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
    END;
END;
$$ LANGUAGE plpgsql;

DROP MATERIALIZED VIEW IF EXISTS mv_suburb_listing_stats;
