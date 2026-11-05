-- Reverses 000155. Drops the snapshot and its registries. The snapshot is rebuilt from the bars, so the
-- loss is the event history and the recorded run log; do not run this against a database whose strategy
-- engine reads them. Deploys never run a down file: 000155 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS strategy_signal_events;
DROP TABLE IF EXISTS strategy_features_daily;
DROP TABLE IF EXISTS strategy_fundamentals_blobs;
DROP TABLE IF EXISTS strategy_regime_daily;
DROP TABLE IF EXISTS strategy_daily_runs;
DROP TABLE IF EXISTS strategy_recipes;
DROP TABLE IF EXISTS strategy_rule_versions;

COMMIT;
