-- Reverses 000158. Drops the backtest tables and every run, series, trade and request in them. Deploys never
-- run a down file: 000158 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS strategy_backtest_trades;
DROP TABLE IF EXISTS strategy_backtest_series;
DROP TABLE IF EXISTS strategy_backtest_runs;
DROP TABLE IF EXISTS strategy_backtest_requests;

COMMIT;
