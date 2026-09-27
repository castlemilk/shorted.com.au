-- Reverse 000129: drop the growth view, then the two tables it reads.
--
-- refresh_strategy_views() (000130) names mv_fundamentals_growth inside a
-- plpgsql body, which Postgres does not dependency-track, so this drop does not
-- need 000130 reverted first; migrate down runs 000130's down before this one
-- anyway.

DROP MATERIALIZED VIEW IF EXISTS mv_fundamentals_growth;
DROP INDEX IF EXISTS idx_stock_fundamentals_code_end;
DROP TABLE IF EXISTS stock_fundamentals_sync;
DROP TABLE IF EXISTS stock_fundamentals;
