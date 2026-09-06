-- Migration 000119: record that a price backfill was ATTEMPTED (#576)
--
-- 936 of 1,941 codes in the point-in-time universe (48%) carry no price
-- history. The standing explanation was that Yahoo drops delisted ASX tickers,
-- so a backfill "recovers some and cannot recover all". That explanation has
-- never been tested, because the backfill never asked:
--
--   * its primary stock list is `asx-stocks/latest.csv` — CURRENT listings;
--   * its database fallback is `mv_stock_price_coverage`, which is
--     `SELECT ... FROM stock_prices GROUP BY stock_code` — codes that ALREADY
--     have prices.
--
-- Both are survivorship-bound, and together they close a loop: a code has no
-- prices because it is never fetched, and it is never fetched because it has no
-- prices. Nothing in the system could distinguish "we asked and the provider
-- had nothing" from "we never asked". This table is the second half of the fix;
-- the first is widening the stock list to the ASIC universe.
--
-- Deliberately NOT a column on `company-metadata`: a delisted code frequently
-- has no metadata row at all, and those are exactly the ones this is about.
-- Keyed on the code itself so an attempt can be recorded for a name we know
-- nothing else about.
--
-- One row per code, overwritten on each attempt. The history of attempts is not
-- interesting; the last outcome is.

CREATE TABLE IF NOT EXISTS stock_price_backfill_attempts (
    stock_code        VARCHAR(20)  PRIMARY KEY,
    last_attempted_at TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- 'recovered'   — the provider returned rows and they were stored
    -- 'unavailable' — the provider was asked and returned nothing
    -- 'error'       — the attempt itself failed (network, quota, parse)
    --
    -- 'unavailable' is the load-bearing value and the reason this table exists:
    -- it is the only way to say "asked, and the data does not exist" rather
    -- than leaving that indistinguishable from silence.
    outcome           VARCHAR(16)  NOT NULL,

    records_recovered INTEGER      NOT NULL DEFAULT 0,
    -- Free text from the provider when outcome = 'error'. Truncated by the
    -- writer; this is a breadcrumb for an operator, not a parseable field.
    detail            TEXT,

    CONSTRAINT stock_price_backfill_attempts_outcome_check
        CHECK (outcome IN ('recovered', 'unavailable', 'error'))
);

-- "Which codes have we never asked about" is the question this answers, and it
-- is asked as an anti-join from the universe, so the primary key carries it.
-- This second index serves the operational view: what failed most recently.
CREATE INDEX IF NOT EXISTS idx_price_backfill_attempts_outcome
    ON stock_price_backfill_attempts (outcome, last_attempted_at DESC);
