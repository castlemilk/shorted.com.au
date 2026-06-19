-- 000049_mv_available_dates (down)

-- Restore the refresh routine to its pre-000049 form (migration 000031).
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;
END;
$$ LANGUAGE plpgsql;

DROP MATERIALIZED VIEW IF EXISTS mv_available_dates;
