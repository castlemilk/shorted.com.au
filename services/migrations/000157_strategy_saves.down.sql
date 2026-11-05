-- Reverses 000157. Drops the saved-strategies table and every save in it. Deploys never run a down
-- file: 000157 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS user_saved_strategies;

COMMIT;
