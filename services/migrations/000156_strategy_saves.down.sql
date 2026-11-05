-- Reverses 000156. Drops the saved-strategies table and every save in it. Deploys never run a down
-- file: 000156 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS user_saved_strategies;

COMMIT;
