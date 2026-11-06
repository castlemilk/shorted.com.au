-- 000159: the paper track's tables (the daily job's paper phase, shorted strategies -mode daily).
--
--   strategy_paper_trades        one row per paper trade: a signal's pending entry, then its open position,
--                                its pending exit and its close, or its cancellation. A row only moves
--                                forward (pending_entry -> open -> pending_exit -> closed, or
--                                pending_entry -> cancelled), and the job refuses any other move.
--   strategy_paper_equity        one row per live version and recipe per session. Never updated.
--   strategy_paper_checkpoints   the simulator's state after the last recorded session, one row per version and
--                                recipe, replaced by each session's. The paper track starts each session from it.
--                                It is not an outcome: nothing reads it but the paper track.
--
-- LOCK ON FIRST APPLY, NONE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). Every table is CREATE TABLE IF NOT EXISTS. The first apply's
-- REFERENCES clauses (rules_hash to strategy_rule_versions, recipe_hash to strategy_recipes) take SHARE ROW
-- EXCLUSIVE on those two tables, so the first apply waits on the daily snapshot's evaluation write (weekdays
-- 13:00-16:40 UTC, which holds those tables). The lock_timeout of 15 s fails the apply cleanly if it cannot get
-- the lock. A replay that has done its work takes no lock on any table: its statements are catalog checks or
-- IF NOT EXISTS. Nothing here writes an existing table.
--
-- No grants, owners, policies or RLS changes, and no function: 000138 closes every table in public on each
-- deploy and this file adds nothing to it. The backend owns these tables.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS strategy_paper_trades (
  id              bigserial PRIMARY KEY,
  strategy_id     text NOT NULL,
  rules_hash      text NOT NULL REFERENCES strategy_rule_versions(rules_hash),
  recipe_hash     text NOT NULL REFERENCES strategy_recipes(recipe_hash),
  engine_version  text NOT NULL,
  stock_code      varchar(10) NOT NULL,
  signal_date     date NOT NULL,
  entry_date      date,
  entry_price     double precision,
  captured_pivot  double precision,
  quantity        double precision,
  exit_signal_date date,
  exit_date       date,
  exit_price      double precision,
  exit_reason     text,
  flags           text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN ('pending_entry','open','pending_exit','closed','cancelled')),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rules_hash, recipe_hash, stock_code, signal_date)
);

CREATE TABLE IF NOT EXISTS strategy_paper_equity (
  rules_hash  text NOT NULL,
  recipe_hash text NOT NULL,
  as_of       date NOT NULL,
  equity      double precision NOT NULL,
  cash        double precision NOT NULL,
  positions   smallint NOT NULL,
  benchmark   double precision,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rules_hash, recipe_hash, as_of)
);

CREATE TABLE IF NOT EXISTS strategy_paper_checkpoints (
  rules_hash  text NOT NULL REFERENCES strategy_rule_versions(rules_hash),
  recipe_hash text NOT NULL REFERENCES strategy_recipes(recipe_hash),
  as_of       date NOT NULL,
  checkpoint  jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rules_hash, recipe_hash)
);

COMMIT;
