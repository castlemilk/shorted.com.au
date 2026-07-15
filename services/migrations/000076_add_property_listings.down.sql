-- Restore the housing refresh function to its pre-000076 (headline-only) body,
-- then drop the drops rollup + listing tables.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
END;
$$ LANGUAGE plpgsql;

DROP MATERIALIZED VIEW IF EXISTS mv_suburb_price_drops;
DROP TABLE IF EXISTS property_price_events;
DROP TABLE IF EXISTS property_listings;
