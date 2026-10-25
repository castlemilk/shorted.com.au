-- 000140: when a past_due subscription's first failed charge happened.
--
-- The 14-day past-due grace used to be anchored on current_period_end. Stripe moves
-- that forward at every renewal it fails, so a card that kept failing never reached
-- the end of the grace. The grace is now anchored on this column instead.
--
-- IDEMPOTENCY
--
-- Prod replays every allowlisted migration on deploy
-- (.github/workflows/terraform-deploy.yml). ALTER TABLE takes ACCESS EXCLUSIVE even
-- when IF NOT EXISTS skips the change, so the column is added only when the catalog
-- lacks it. A replay then takes no lock and touches no rows. Existing rows are NULL,
-- which means no grace, and the next Stripe sync of a past_due subscription starts it.
BEGIN;
SET LOCAL lock_timeout = '15s';
DO $m140_past_due_since$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('api_subscriptions')
      AND attname = 'past_due_since'
      AND NOT attisdropped
  ) THEN
    -- IF NOT EXISTS is redundant inside the guard: migration-drift.test.mjs requires
    -- an allowlisted ADD COLUMN, and the guard keeps a replay from taking the lock.
    ALTER TABLE api_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ;
  END IF;
END
$m140_past_due_since$;
COMMIT;
