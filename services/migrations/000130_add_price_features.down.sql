-- Reverse 000130: the refresh function first (it names both views), then the
-- two views. Their unique indexes go with them. mv_fundamentals_growth belongs
-- to 000129 and is dropped by its down migration.

DROP FUNCTION IF EXISTS refresh_strategy_views();
DROP MATERIALIZED VIEW IF EXISTS mv_market_regime;
DROP MATERIALIZED VIEW IF EXISTS mv_price_features;
