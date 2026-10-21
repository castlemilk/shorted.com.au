-- Reverse 000139. The function goes first, so nothing is left that names a
-- missing view. The suburb readers fall back to their live SQL when the views
-- are absent (42P01), so this is safe with the API running.

BEGIN;

DROP FUNCTION IF EXISTS refresh_suburb_reference_views();

DROP MATERIALIZED VIEW IF EXISTS mv_suburb_similarity_features;
DROP MATERIALIZED VIEW IF EXISTS mv_housing_state_baselines;
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_latest_price;

COMMIT;
