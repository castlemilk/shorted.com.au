-- Property-listing price tracking. Individual for-sale listings crawled from
-- realestate.com.au / domain.com.au SEARCH-results pages (a level deeper than the
-- suburb-median crawl in 000053/000054), plus their asking-price time series.
--
-- LICENCE: raw listing rows are proprietary/ToS-restricted (same posture as the
-- crawl_rea/crawl_domain medians) and MUST NEVER be republished. Only the DERIVED
-- aggregate mv_suburb_price_drops is a publishable surface; the per-listing
-- drill-down read path deep-links OUT to the live portal page rather than
-- reproducing the listing. Gate any public read on source_licence.

-- One row per portal listing: stable identity + latest snapshot.
CREATE TABLE IF NOT EXISTS property_listings (
    id                   BIGSERIAL PRIMARY KEY,
    source               TEXT NOT NULL,                 -- 'rea' | 'domain'
    listing_id           TEXT NOT NULL,                 -- portal advert id
    listing_url          TEXT NOT NULL,                 -- deep link to the live portal listing
    region_code          TEXT REFERENCES house_price_regions(region_code), -- 'SUBURB:NSW-2026-BONDI'
    sal_code             TEXT,                          -- ABS SAL bridge (backfilled from region)
    suburb               TEXT,
    state_code           TEXT,
    postcode             TEXT,
    display_address      TEXT,
    latitude             DOUBLE PRECISION,
    longitude            DOUBLE PRECISION,
    property_type        TEXT,
    bedrooms             SMALLINT,
    bathrooms            SMALLINT,
    car_spaces           SMALLINT,
    land_size_sqm        DOUBLE PRECISION,
    price                DOUBLE PRECISION,              -- canonical numeric ask (NULL for auction/POA/unknown)
    price_high           DOUBLE PRECISION,              -- upper bound for ranges
    price_display        TEXT,                          -- raw string as shown on the portal
    price_kind           TEXT NOT NULL DEFAULT 'unknown', -- fixed|range_low|range_high|offers_over|auction|poa|unknown
    listing_status       TEXT NOT NULL DEFAULT 'for_sale', -- for_sale|under_offer|sold|withdrawn|unknown
    is_active            BOOLEAN NOT NULL DEFAULT true,
    missed_sweeps        SMALLINT NOT NULL DEFAULT 0,    -- consecutive COMPLETE sweeps this listing was absent
    first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- last TRUSTED sweep it appeared in
    last_price_change_at TIMESTAMPTZ,
    source_licence       TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
    content_hash         TEXT NOT NULL,                 -- sha1 of the snapshot
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_property_listings_region_active
    ON property_listings (region_code, is_active);
CREATE INDEX IF NOT EXISTS idx_property_listings_sal ON property_listings (sal_code);
CREATE INDEX IF NOT EXISTS idx_property_listings_lastseen ON property_listings (last_seen_at DESC);

-- The asking-price time series: one row per detected event per listing per run.
CREATE TABLE IF NOT EXISTS property_price_events (
    id             BIGSERIAL PRIMARY KEY,
    listing_pk     BIGINT NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
    source         TEXT NOT NULL,       -- denormalized for cheap joins
    listing_id     TEXT NOT NULL,
    region_code    TEXT,                -- denormalized: drives the suburb rollup without a join back
    sal_code       TEXT,
    observed_at    TIMESTAMPTZ NOT NULL, -- the RUN timestamp (identical for every event in a run)
    event_type     TEXT NOT NULL,       -- first_seen|price_drop|price_rise|relisted|status_change|delisted
    price          DOUBLE PRECISION,
    price_high     DOUBLE PRECISION,
    price_display  TEXT,
    price_kind     TEXT,
    prev_price     DOUBLE PRECISION,    -- for drop/rise
    drop_abs       DOUBLE PRECISION,    -- prev_price - price  (POSITIVE == a drop)
    drop_pct       DOUBLE PRECISION,    -- drop_abs / prev_price, as a FRACTION (0.062 == a 6.2% drop)
    listing_status TEXT,
    prev_status    TEXT,
    source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (listing_pk, event_type, observed_at)  -- idempotent re-runs
);

CREATE INDEX IF NOT EXISTS idx_price_events_listing
    ON property_price_events (listing_pk, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_events_drops
    ON property_price_events (region_code, observed_at DESC)
    WHERE event_type = 'price_drop';

-- Publishable derived rollup: per-suburb price-drop signal over a rolling 30-day
-- window. DISTINCT ON keeps the single most-severe drop per listing (no
-- double-count when a listing drops twice); the n>=3 floor is a noise/privacy gate
-- so we never surface a suburb off one or two listings.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_suburb_price_drops AS
WITH win AS (
    SELECT DISTINCT ON (listing_pk)
        region_code, listing_pk, drop_pct, drop_abs
    FROM property_price_events
    WHERE event_type = 'price_drop'
      AND observed_at >= now() - interval '30 days'
      AND drop_pct IS NOT NULL
    ORDER BY listing_pk, drop_pct DESC
), agg AS (
    SELECT region_code,
        COUNT(*)                                               AS dropped_listing_count,
        AVG(drop_pct)                                          AS avg_drop_pct,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY drop_pct)  AS median_drop_pct,
        MAX(drop_pct)                                          AS max_drop_pct,
        MAX(drop_abs)                                          AS max_drop_abs
    FROM win
    GROUP BY region_code
), active AS (
    SELECT region_code, COUNT(*) AS total_active_listings
    FROM property_listings
    WHERE is_active
    GROUP BY region_code
)
SELECT a.region_code,
       a.dropped_listing_count,
       a.avg_drop_pct,
       a.median_drop_pct,
       a.max_drop_pct,
       a.max_drop_abs,
       COALESCE(ac.total_active_listings, 0) AS total_active_listings,
       a.dropped_listing_count::float / NULLIF(ac.total_active_listings, 0) AS dropped_share
FROM agg a
LEFT JOIN active ac USING (region_code)
WHERE a.dropped_listing_count >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key
    ON mv_suburb_price_drops (region_code);

-- Extend the shared housing refresh to also refresh the drops rollup. The nested
-- block falls back to a blocking refresh if CONCURRENTLY can't run yet (e.g. the
-- MV has never been populated), so the drops board still lights up on first run.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
    END;
END;
$$ LANGUAGE plpgsql;
