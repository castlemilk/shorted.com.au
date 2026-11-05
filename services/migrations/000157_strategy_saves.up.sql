-- 000157: saved strategies for the signed-in user (the My strategies list).
--
--   user_saved_strategies  one row per (user, strategy). strategy_ref is a canonical strategy id, or
--                          'variant:<id>' for a variant the user owns. created_at is the first save: a
--                          repeat save keeps it. The cap of 20 saves per user is enforced by the save
--                          statement itself (strategy saves are stored in the Go store, which takes a
--                          per-user advisory lock first so two saves cannot both see 19).
--
-- LOCK-FREE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). The table is CREATE TABLE IF NOT EXISTS and nothing else is
-- written here, so a replay takes no lock beyond the catalog check and touches no row.
--
-- No grants, owners, policies or RLS: 000138 closes every table in public on each deploy, and the backend
-- owns this table. Readers tolerate its absence (42P01) for one release.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS user_saved_strategies (
  user_id      TEXT NOT NULL,
  strategy_ref TEXT NOT NULL CONSTRAINT user_saved_strategies_ref_check
    CHECK (strategy_ref ~ '^([a-z0-9-]{1,64}|variant:[A-Za-z0-9-]{1,64})$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy_ref)
);

COMMIT;
