-- 000155: the strategy engine's daily snapshot (PR-10).
--
--   strategy_rule_versions   one row per published rules hash: the canonical versions the product shows
--                            (v0 now) and, from PR-27, the variants an owner saves. The hash is the
--                            version's identity everywhere it is shown.
--   strategy_recipes         the execution recipes backtests trade with (PR-12a), keyed by their hash.
--   strategy_daily_runs      one row per session and phase: the daily job's progress, its holds and the
--                            counts a reader needs to tell a late (backfilled) session from a current one.
--   strategy_regime_daily    the market regime per session and index.
--   strategy_fundamentals_blobs  the fundamentals body a feature row froze, keyed by its provenance-free
--                            hash, so a re-fetch with unchanged figures reuses the blob.
--   strategy_features_daily  the stored feature row of one stock on one session (snapshot.Row): the input
--                            every evaluation of that session reads, so a published result can be
--                            reproduced from what was known that day.
--   strategy_signal_events   the status transitions of the canonical versions (2.1), diffed against the
--                            previous completed session.
--
-- LOCK-FREE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). Every table is CREATE TABLE IF NOT EXISTS, and every index is
-- created only when the catalog lacks it, so a replay that has done its work writes no row and takes no
-- lock on a table it does not create. Nothing here reads or writes the existing tables.
--
-- No grants, owners, policies or RLS changes: the Data API closer (000138) stays the last file the deploy
-- replays, and this file adds nothing to it.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS strategy_rule_versions (
  rules_hash      text PRIMARY KEY CHECK (rules_hash ~ '^[0-9a-f]{64}$'),
  strategy_id     text NOT NULL,
  label           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('canonical','variant')),
  base_rules_hash text REFERENCES strategy_rule_versions(rules_hash),
  engine_major    integer NOT NULL,
  feature_set     text NOT NULL,
  canonical_json  jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','superseded','retired')),
  live_from       date,
  superseded_on   date,
  retired_on      date,
  changes         text[] NOT NULL DEFAULT '{}',
  known_issues    text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_recipes (
  recipe_hash    text PRIMARY KEY CHECK (recipe_hash ~ '^[0-9a-f]{64}$'),
  strategy_id    text NOT NULL,
  recipe_id      text NOT NULL,
  canonical_json jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_daily_runs (
  as_of            date NOT NULL,
  phase            text NOT NULL CHECK (phase IN ('features','evaluation','events','paper','alerts')),
  status           text NOT NULL CHECK (status IN ('running','completed','failed','held')),
  engine_version   text NOT NULL,
  rules_hashes     text[] NOT NULL DEFAULT '{}',
  asic_report_date date,
  asic_available_date date,
  xjo_date         date,
  counts           jsonb NOT NULL DEFAULT '{}',
  note             text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (as_of, phase)
);

CREATE TABLE IF NOT EXISTS strategy_regime_daily (
  as_of          date NOT NULL,
  index_code     text NOT NULL,
  close          double precision,
  sma50          double precision,
  sma200         double precision,
  pct_off_52w_high double precision,
  ret_1m_pct     double precision,
  ret_3m_pct     double precision,
  regime         text CHECK (regime IN ('uptrend','neutral','downtrend')),
  PRIMARY KEY (as_of, index_code)
);

CREATE TABLE IF NOT EXISTS strategy_fundamentals_blobs (
  hash       text PRIMARY KEY,
  body       jsonb NOT NULL,
  first_seen date NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_features_daily (
  as_of             date NOT NULL,
  feature_set       text NOT NULL,
  stock_code        varchar(10) NOT NULL,
  bar_date          date,
  ordinary_fresh_60 boolean NOT NULL,
  ineligible_reason text,
  is_ordinary       boolean NOT NULL,
  in_asic_report    boolean NOT NULL,
  short_report_date date,
  short_available_date date,
  short_status      text,
  ca_suspect_date   date,
  features          jsonb NOT NULL,
  fundamentals_hash text REFERENCES strategy_fundamentals_blobs(hash),
  meta              jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (as_of, feature_set, stock_code)
);

CREATE TABLE IF NOT EXISTS strategy_signal_events (
  id             bigserial PRIMARY KEY,
  rules_hash     text NOT NULL REFERENCES strategy_rule_versions(rules_hash),
  engine_version text NOT NULL,
  strategy_id    text NOT NULL,
  stock_code     varchar(10) NOT NULL,
  as_of          date NOT NULL,
  prev_as_of     date,
  from_status    text NOT NULL CHECK (from_status IN ('triggered','setup','unknown','watch','none')),
  to_status      text NOT NULL CHECK (to_status   IN ('triggered','setup','unknown','watch','none')),
  score          real,
  evidence       jsonb,
  source         text NOT NULL DEFAULT 'live' CHECK (source = 'live'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rules_hash, stock_code, as_of)
);

-- The one live canonical version per strategy. Guarded: the index is built only when the catalog lacks it.
DO $m155_idx_live$
BEGIN
  IF to_regclass('public.idx_srv_one_live') IS NULL THEN
    CREATE UNIQUE INDEX idx_srv_one_live ON strategy_rule_versions (strategy_id)
      WHERE status = 'live' AND kind = 'canonical';
  END IF;
END $m155_idx_live$;

-- The blob prune's anti-join and the foreign key check probe this index (9.9).
DO $m155_idx_fhash$
BEGIN
  IF to_regclass('public.idx_sfd_fundamentals_hash') IS NULL THEN
    CREATE INDEX idx_sfd_fundamentals_hash ON strategy_features_daily (fundamentals_hash);
  END IF;
END $m155_idx_fhash$;

DO $m155_idx_sse_strategy$
BEGIN
  IF to_regclass('public.idx_sse_strategy_date') IS NULL THEN
    CREATE INDEX idx_sse_strategy_date ON strategy_signal_events (strategy_id, as_of DESC);
  END IF;
END $m155_idx_sse_strategy$;

DO $m155_idx_sse_code$
BEGIN
  IF to_regclass('public.idx_sse_code_date') IS NULL THEN
    CREATE INDEX idx_sse_code_date ON strategy_signal_events (stock_code, as_of DESC);
  END IF;
END $m155_idx_sse_code$;

COMMIT;
