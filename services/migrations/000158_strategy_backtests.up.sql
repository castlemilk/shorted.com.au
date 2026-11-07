-- 000158: the strategy backtest job's tables (the backtest job, shorted strategies -mode backtest).
--
--   strategy_backtest_runs      one row per run: a publish (the canonical version and recipe, the
--                               published one per key flipped by the job), a verify rerun of the same
--                               input, or a variant run. Metrics, summary (annual, monthly, coverage,
--                               survivorship, sensitivity, reference, identity) and diagnostics (data
--                               notes, the per-code digests of a canonical run) are jsonb.
--   strategy_backtest_series    one points document per run: daily for a canonical run, weekly for a variant.
--   strategy_backtest_trades    one row per trade of a run.
--   strategy_backtest_requests  the queue: a publish request per live canonical version and recipe per ISO
--                               week (and once more when no run has succeeded), a variant request per save.
--
-- LOCK ON FIRST APPLY, NONE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). Every table is CREATE TABLE IF NOT EXISTS, and every index is
-- created only when the catalog lacks it. The first apply's two REFERENCES clauses (rules_hash to
-- strategy_rule_versions, recipe_hash to strategy_recipes) take SHARE ROW EXCLUSIVE on those two tables, so
-- the first apply waits on the daily snapshot's evaluation write (weekdays 13:00-16:40 UTC, which holds
-- those tables). The lock_timeout of 15 s fails the apply cleanly if it cannot get the lock. A replay that
-- has done its work takes no lock on any table: its statements are all catalog checks or IF NOT EXISTS.
-- Nothing here writes an existing table.
--
-- No grants, owners, policies or RLS changes, and no function: 000138 closes every table in public on each
-- deploy and this file adds nothing to it. The backend owns these tables.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS strategy_backtest_runs (
  id              bigserial PRIMARY KEY,
  run_key         text,
  kind            text NOT NULL CHECK (kind IN ('publish','variant','verify')),
  strategy_id     text NOT NULL,
  rules_hash      text NOT NULL REFERENCES strategy_rule_versions(rules_hash),
  recipe_hash     text NOT NULL REFERENCES strategy_recipes(recipe_hash),
  engine_version  text NOT NULL,
  variant_id      text,
  status          text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  published       boolean NOT NULL DEFAULT false,
  window_start    date NOT NULL,
  window_end      date,
  computable_from date,
  fiscal_label    text,
  returns         text NOT NULL CHECK (returns IN ('total')),
  benchmark_code  text NOT NULL CHECK (benchmark_code IN ('XJT')),
  fundamentals    text NOT NULL DEFAULT 'strict' CHECK (fundamentals IN ('strict','approx_period_end_plus_2m')),
  input_hash      text,
  output_hash     text,
  build_revision  text,
  goarch          text,
  prices_through  date,
  asic_report_through date,
  index_through   date,
  in_sample_until date,
  metrics         jsonb,
  summary         jsonb,
  diagnostics     jsonb NOT NULL DEFAULT '{}',
  error           text,
  execution       text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE TABLE IF NOT EXISTS strategy_backtest_series (
  run_id bigint PRIMARY KEY REFERENCES strategy_backtest_runs(id) ON DELETE CASCADE,
  points jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_backtest_trades (
  run_id          bigint NOT NULL REFERENCES strategy_backtest_runs(id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  stock_code      varchar(10) NOT NULL,
  signal_date     date NOT NULL,
  entry_date      date,
  entry_price     double precision,
  captured_pivot  double precision,
  entry_score     real,
  exit_signal_date date,
  exit_date       date,
  exit_price      double precision,
  exit_reason     text,
  sessions_held   integer,
  gross_return_pct double precision,
  net_return_pct  double precision,
  flags           text[] NOT NULL DEFAULT '{}',
  open            boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS strategy_backtest_requests (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('publish','variant')),
  strategy_id  text NOT NULL,
  rules_hash   text NOT NULL,
  recipe_hash  text NOT NULL,
  variant_id   text,
  requested_by text,
  dedupe_key   text NOT NULL UNIQUE,
  status       text NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  run_id       bigint,
  error        text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- One published run per canonical key and fundamentals policy. Guarded: built only when the catalog lacks it.
DO $m158_idx_published$
BEGIN
  IF to_regclass('public.idx_sbr_published') IS NULL THEN
    CREATE UNIQUE INDEX idx_sbr_published ON strategy_backtest_runs (strategy_id, rules_hash, recipe_hash, fundamentals)
      WHERE published;
  END IF;
END $m158_idx_published$;

-- An identical rerun is detected, not stored twice. Verify reruns are excluded: they share their publish's key.
DO $m158_idx_run_key$
BEGIN
  IF to_regclass('public.idx_sbr_run_key') IS NULL THEN
    CREATE UNIQUE INDEX idx_sbr_run_key ON strategy_backtest_runs (run_key)
      WHERE status = 'succeeded' AND kind <> 'verify';
  END IF;
END $m158_idx_run_key$;

DO $m158_idx_variant$
BEGIN
  IF to_regclass('public.idx_sbr_variant') IS NULL THEN
    CREATE INDEX idx_sbr_variant ON strategy_backtest_runs (variant_id, finished_at DESC)
      WHERE variant_id IS NOT NULL;
  END IF;
END $m158_idx_variant$;

DO $m158_idx_trades$
BEGIN
  IF to_regclass('public.idx_sbt_run_code') IS NULL THEN
    CREATE INDEX idx_sbt_run_code ON strategy_backtest_trades (run_id, stock_code);
  END IF;
END $m158_idx_trades$;

DO $m158_idx_queue$
BEGIN
  IF to_regclass('public.idx_sbq_queue') IS NULL THEN
    CREATE INDEX idx_sbq_queue ON strategy_backtest_requests (kind, requested_at) WHERE status = 'queued';
  END IF;
END $m158_idx_queue$;

DO $m158_idx_user$
BEGIN
  IF to_regclass('public.idx_sbq_user') IS NULL THEN
    CREATE INDEX idx_sbq_user ON strategy_backtest_requests (requested_by, requested_at DESC)
      WHERE requested_by IS NOT NULL;
  END IF;
END $m158_idx_user$;

COMMIT;
