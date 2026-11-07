-- Reverses 000159. Drops the paper track's tables and every trade, equity row and checkpoint in them. Deploys
-- never run a down file: 000159 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS strategy_paper_checkpoints;
DROP TABLE IF EXISTS strategy_paper_equity;
DROP TABLE IF EXISTS strategy_paper_trades;

COMMIT;
