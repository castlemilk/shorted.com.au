-- Rollback: Drop materialized views and refresh function

DROP FUNCTION IF EXISTS refresh_all_materialized_views();
DROP MATERIALIZED VIEW IF EXISTS mv_watchlist_defaults CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_top_shorts CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_treemap_data CASCADE;
