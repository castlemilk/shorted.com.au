DROP FUNCTION IF EXISTS refresh_housing_materialized_views();
DROP MATERIALIZED VIEW IF EXISTS mv_housing_headline;
DROP TABLE IF EXISTS house_price_ingest_runs;
DROP TABLE IF EXISTS house_prices;
DROP TABLE IF EXISTS house_price_regions;
