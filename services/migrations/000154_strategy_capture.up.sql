-- 000154: forward point-in-time capture for the strategy workspace (PR-02, architecture 9.1).
--
--   asic_report_ingests           one row per ASIC short-position report: when we first saw it, how many
--                                 rows ASIC's file carried, and how many of those are in shorts now. Read
--                                 by the completeness rule (4.6, R23): a report is complete when
--                                 loaded_rows >= file_rows. Written by shortdatasync, not by a trigger.
--   shorts_revisions              one row per value ASIC later changed in a report we already held. Written
--                                 by shortdatasync's reconcile pass, not by a trigger: shorts holds 2.1M
--                                 rows and must not gain one.
--   stock_fundamentals_vintages   the version history of stock_fundamentals: a baseline of every row
--                                 (op 'B'), then every insert ('I'), change ('U') and delete ('D').
--                                 THE LATEST VINTAGE ON OR BEFORE D is the row with the greatest
--                                 (captured_at, id) whose captured_at is at or before D. Order by both:
--                                 now() is one value for a whole transaction, so every vintage a
--                                 transaction writes shares its captured_at, and id (BIGSERIAL, in write
--                                 order) is what picks the last of them. The filings rebuild writes several
--                                 vintages of one row in one transaction, some of them intermediate states.
--
-- LOCK-FREE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). Every table is CREATE TABLE IF NOT EXISTS. Every index and the
-- trigger are created only when the catalog lacks them, and the baseline runs only into an empty vintage
-- table, so a replay that has already done its work takes no lock on stock_fundamentals and writes no row.
-- The one exception is the first application, which takes SHARE ROW EXCLUSIVE on stock_fundamentals to
-- create the trigger (writers wait for the commit; picks writes stop for a moment). Run it outside the
-- picks window (architecture 9.1: not between 15:00 and 18:30 UTC).
--
-- The trigger function is CREATE OR REPLACE: it changes no table and no row.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asic_report_ingests (
    report_date       DATE PRIMARY KEY,
    -- Preserved on conflict: the observed publication time. Measures the real lag (4.5) from the day
    -- this migration lands; a report first seen by reconcile (mode 'reconcile') shows the reconcile time.
    first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Distinct product codes parsed from ASIC's file for this date.
    file_rows         INTEGER,
    -- Of those codes, how many are present in shorts for this date after the write. Recomputed by every mode.
    loaded_rows       INTEGER NOT NULL,
    source_file       TEXT,
    -- The first mode that recorded the report, kept on conflict.
    mode              TEXT NOT NULL CONSTRAINT asic_report_ingests_mode_check
                      CHECK (mode IN ('daily', 'poll', 'reconcile')),
    -- The latest mode that recorded it.
    last_mode         TEXT NOT NULL CONSTRAINT asic_report_ingests_last_mode_check
                      CHECK (last_mode IN ('daily', 'poll', 'reconcile'))
);

CREATE TABLE IF NOT EXISTS shorts_revisions (
    id            BIGSERIAL PRIMARY KEY,
    report_date   DATE NOT NULL,
    product_code  TEXT NOT NULL,
    old_positions DOUBLE PRECISION,
    new_positions DOUBLE PRECISION,
    old_shares    DOUBLE PRECISION,
    new_shares    DOUBLE PRECISION,
    old_percent   DOUBLE PRECISION,
    new_percent   DOUBLE PRECISION,
    revised_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_fundamentals_vintages (
    id          BIGSERIAL PRIMARY KEY,
    stock_code  VARCHAR(10) NOT NULL,
    period_type VARCHAR(8)  NOT NULL,
    period_end  DATE        NOT NULL,
    -- B baseline, I insert, U update, D delete.
    op          CHAR(1)     NOT NULL CONSTRAINT stock_fundamentals_vintages_op_check
                            CHECK (op IN ('B', 'I', 'U', 'D')),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- to_jsonb(row) without updated_at and source_fetched_at, which move on every re-fetch.
    row_json    JSONB       NOT NULL
);

DO $m154_idx_revisions$
BEGIN
  IF to_regclass('public.idx_shorts_revisions_code_date') IS NULL THEN
    CREATE INDEX idx_shorts_revisions_code_date ON shorts_revisions (product_code, report_date);
  END IF;
END $m154_idx_revisions$;

DO $m154_idx_vintages$
BEGIN
  IF to_regclass('public.idx_sfv_key_time') IS NULL THEN
    CREATE INDEX idx_sfv_key_time ON stock_fundamentals_vintages (stock_code, period_type, period_end, captured_at, id);
  END IF;
END $m154_idx_vintages$;

-- One function for the three operations. An UPDATE that changes nothing but the two provenance columns
-- writes no vintage, so a nightly re-fetch of unchanged figures adds nothing to the history. A DELETE writes
-- the deleted row, so "the latest vintage" can tell a deleted key from a live one.
CREATE OR REPLACE FUNCTION record_fundamentals_vintage() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $f$
DECLARE newj jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO stock_fundamentals_vintages (stock_code, period_type, period_end, op, row_json)
    VALUES (OLD.stock_code, OLD.period_type, OLD.period_end, 'D',
            to_jsonb(OLD) - 'updated_at' - 'source_fetched_at')
    ON CONFLICT DO NOTHING;
    RETURN OLD;
  END IF;
  newj := to_jsonb(NEW) - 'updated_at' - 'source_fetched_at';
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'updated_at' - 'source_fetched_at') = newj THEN
    RETURN NEW;
  END IF;
  INSERT INTO stock_fundamentals_vintages (stock_code, period_type, period_end, op, row_json)
  VALUES (NEW.stock_code, NEW.period_type, NEW.period_end,
          CASE WHEN TG_OP = 'INSERT' THEN 'I' ELSE 'U' END, newj)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $f$;

DO $m154_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.stock_fundamentals'::regclass
      AND tgname = 'trg_fundamentals_vintage'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_fundamentals_vintage
      AFTER INSERT OR UPDATE OR DELETE ON stock_fundamentals
      FOR EACH ROW EXECUTE FUNCTION record_fundamentals_vintage();
  END IF;
END $m154_trigger$;

-- The baseline: one 'B' row per row that exists when the vintage history first starts. It runs only into an
-- empty vintage table, so it runs once. The table lock is taken only on that branch, and it stops a writer
-- from adding an 'I' between the emptiness check and the copy.
DO $m154_baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_fundamentals_vintages) THEN
    LOCK TABLE stock_fundamentals IN SHARE ROW EXCLUSIVE MODE;
    IF NOT EXISTS (SELECT 1 FROM stock_fundamentals_vintages) THEN
      INSERT INTO stock_fundamentals_vintages (stock_code, period_type, period_end, op, row_json)
      SELECT f.stock_code, f.period_type, f.period_end, 'B', to_jsonb(f) - 'updated_at' - 'source_fetched_at'
      FROM stock_fundamentals f
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END $m154_baseline$;

COMMIT;
