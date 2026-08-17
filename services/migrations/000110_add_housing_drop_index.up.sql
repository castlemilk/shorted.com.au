-- Daily discounting index for /price-drops.
--
-- Append-only rather than a view: this number gets published, and a derived
-- series would let a listings purge or a late backfill silently rewrite a
-- figure quoted last week.
--
-- panel_suburbs / coverage_ratio / is_gap are not optional. The crawl catalog
-- grew 115 -> 500 suburbs over July-August 2026 and stopped entirely on
-- 2026-08-13..15; without these columns a reader cannot tell a market move
-- from a crawl artefact.

CREATE TABLE IF NOT EXISTS housing_drop_index_daily (
    snapshot_date     date             NOT NULL,
    grain             text             NOT NULL,
    grain_key         text             NOT NULL,

    active_addresses  integer          NOT NULL,
    dropped_addresses integer          NOT NULL,
    drop_rate         double precision NOT NULL,
    median_drop_pct   double precision NOT NULL,
    relisted_lower    integer          NOT NULL,
    delisted_count    integer          NOT NULL,

    panel_suburbs     integer          NOT NULL,
    coverage_ratio    double precision NOT NULL,
    -- is_gap defaults to true (fail closed): a missing flag must never read as a healthy day.
    -- If this column is omitted from an insert, the row is marked as untrustworthy.
    -- This prevents crawl artefacts (missing driver, blocked portal, etc.) from silently
    -- looking like real market moves.
    is_gap            boolean          NOT NULL DEFAULT true,

    computed_at       timestamptz      NOT NULL DEFAULT now(),

    PRIMARY KEY (snapshot_date, grain, grain_key),
    CONSTRAINT housing_drop_index_grain_check
        CHECK (grain IN ('national', 'state', 'suburb'))
);

-- The read path is always "one series for one grain_key over a date range".
CREATE INDEX IF NOT EXISTS idx_housing_drop_index_series
    ON housing_drop_index_daily (grain, grain_key, snapshot_date DESC);
