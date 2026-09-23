-- Price-drops honesty: a listing is "active" only if the crawl has actually
-- seen it recently, every drops read can say how old it is, and the state
-- rollup says how much of the catalog stands behind it.
--
-- 1. RECENCY GATE. is_active only flips after delistGrace COMPLETE sweeps of a
--    listing's own suburb (crawl_listings_diff.go), so a suburb the crawl stops
--    reaching keeps every listing "active" forever. Measured on prod 2026-09-23:
--    72,483 of 92,535 active listings (78%) unseen for 21+ days; SA 0 of 66
--    catalog suburbs swept in 30 days, WA 3 of 67, QLD 4 of 97. Every 000109
--    denominator (total_active_listings, for_sale_count, median_asking,
--    agency active_listings) counted those zombies while numerators only grew
--    where sweeps happened, so the state board ranked crawl coverage
--    (VIC 4.4%, NSW 3.7% vs SA 1.3%, WA 1.2%) rather than discounting.
--
--    "Active" is now `is_active AND last_seen_at >= now() - interval '14 days'`
--    in EVERY active/asking CTE below. 14 days is the drop index's sweep window
--    (drop_index.go indexSweepWindowDays: one full rotation of the 500-suburb
--    catalog), so the index, these views and the API drill-downs
--    (postgres_house_prices.go) all agree on who is on the market. Every 000109
--    guard is kept verbatim: address_key unit, 40% event cap, k>=3 floors,
--    12-month sold window, deterministic address winners, UNIQUE indexes.
--
-- 2. COVERAGE. mv_state_price_drops gains catalog_suburbs and
--    suburbs_swept_14d. The catalog is defined EXACTLY as the collector's
--    coverage denominator (drop_index.go queryCatalogSizes): distinct sal_code
--    ever produced by the crawl in property_listings, per state and nationally.
--    Swept = a listing row of that suburb seen in the last 14 days (the same
--    sweep-window membership as suburbDaysSQL). The API derives the coverage
--    ratio and greys out a state below the index's 0.6 gap threshold instead
--    of ranking it. A catalog state with no recent sweep now still gets a row
--    (coverage 0) rather than silently vanishing from the board.
--
-- 3. FRESHNESS. housing_mv_refresh records, per view, when it was last
--    refreshed (refreshed_at = now() of the refreshing transaction, which is
--    exactly the instant every now()-relative window in the view is anchored
--    to) and the crawl horizon it reflects (data_through = newest crawl
--    observation, price event or listing sighting, read BEFORE the refresh so
--    it can only understate what the view holds). The API reads it into
--    as_of / data_through. refresh_housing_materialized_views() keeps 000107's
--    query_canceled-aware guard shape for every view prod refreshes and
--    records each view's row only after that view refreshed.
--
-- 4. INDEX k-FLOOR. housing_drop_index_daily.median_drop_pct becomes nullable:
--    a median over fewer than 3 dropped addresses is one or two listings'
--    exact cuts, so the collector now writes NULL ("withheld") there, and the
--    1,794 historical suburb rows that published one are scrubbed below.
--
-- Hand-applied (prod does not run `migrate up`): session pooler 5432. The
-- statement timeout is disarmed INSIDE the transaction because Supavisor drops
-- PGOPTIONS, and the whole file is one transaction so readers block on the
-- rebuild instead of 500ing on a missing view. Replay-safe: every object is
-- IF EXISTS / IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.

BEGIN;

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1. Per-suburb asking + 12-month sold prices, address-deduped with k-anon.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_listing_stats;
CREATE MATERIALIZED VIEW mv_suburb_listing_stats AS
WITH asking_addresses AS (
    SELECT DISTINCT ON (pl.address_key)
           pl.region_code, pl.address_key, pl.price
    FROM property_listings pl
    WHERE pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND pl.listing_status IN ('for_sale', 'under_offer')
      AND NULLIF(pl.address_key, '') IS NOT NULL
    ORDER BY pl.address_key, pl.last_seen_at DESC, pl.source, pl.listing_id
), fs AS (
    SELECT region_code,
           COUNT(*) AS for_sale_count,
           COUNT(price) AS for_sale_priced,
           AVG(price) AS avg_asking,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
               FILTER (WHERE price IS NOT NULL) AS median_asking
    FROM asking_addresses
    GROUP BY region_code
), sold_transitions AS (
    SELECT DISTINCT ON (e.listing_pk)
           e.listing_pk, e.observed_at AS sold_at
    FROM property_price_events e
    WHERE e.event_type IN ('first_seen', 'status_change', 'relisted')
      AND e.listing_status = 'sold'
    ORDER BY e.listing_pk, e.observed_at DESC
), sold_addresses AS (
    SELECT DISTINCT ON (pl.address_key)
           pl.region_code, pl.address_key, pl.price, st.sold_at
    FROM sold_transitions st
    JOIN property_listings pl ON pl.id = st.listing_pk
    WHERE pl.listing_status = 'sold'
      AND pl.price IS NOT NULL
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND st.sold_at >= now() - interval '12 months'
    ORDER BY pl.address_key, st.sold_at DESC, pl.last_seen_at DESC, pl.source, pl.listing_id
), sold AS (
    SELECT region_code,
           COUNT(*) AS sold_count,
           AVG(price) AS avg_sold,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_sold
    FROM sold_addresses
    GROUP BY region_code
)
SELECT COALESCE(fs.region_code, sold.region_code) AS region_code,
       COALESCE(fs.for_sale_count, 0) AS for_sale_count,
       COALESCE(fs.for_sale_priced, 0) AS for_sale_priced,
       CASE WHEN fs.for_sale_priced >= 3 THEN fs.avg_asking END AS avg_asking,
       CASE WHEN fs.for_sale_priced >= 3 THEN fs.median_asking END AS median_asking,
       COALESCE(sold.sold_count, 0) AS sold_count,
       CASE WHEN sold.sold_count >= 3 THEN sold.avg_sold END AS avg_sold,
       CASE WHEN sold.sold_count >= 3 THEN sold.median_sold END AS median_sold
FROM fs
FULL OUTER JOIN sold USING (region_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_listing_stats_key
    ON mv_suburb_listing_stats (region_code);

-- ---------------------------------------------------------------------------
-- 2. Per-suburb 30-day drops. Numerator and denominator are both the
--    recently-swept, active, addressable population.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_price_drops;
CREATE MATERIALIZED VIEW mv_suburb_price_drops AS
WITH ev AS (
    SELECT pl.region_code, e.source, pl.address_key AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    JOIN property_listings pl ON pl.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
      AND pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND NULLIF(pl.address_key, '') IS NOT NULL
), per_source AS (
    SELECT region_code, dedup_key, source,
           MAX(drop_pct) AS max_pct,
           MAX(drop_abs) AS max_abs,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY region_code, dedup_key, source
), win AS (
    SELECT DISTINCT ON (region_code, dedup_key)
           region_code, dedup_key, max_pct, max_abs, total_abs
    FROM per_source
    ORDER BY region_code, dedup_key, total_abs DESC, source
), agg AS (
    SELECT region_code,
           COUNT(*) AS dropped_listing_count,
           AVG(max_pct) AS avg_drop_pct,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_drop_pct,
           MAX(max_pct) AS max_drop_pct,
           MAX(max_abs) AS max_drop_abs,
           SUM(total_abs) AS dropped_value
    FROM win
    GROUP BY region_code
), active AS (
    SELECT region_code, COUNT(DISTINCT address_key) AS total_active_listings
    FROM property_listings
    WHERE is_active
      AND last_seen_at >= now() - interval '14 days'
      AND NULLIF(address_key, '') IS NOT NULL
    GROUP BY region_code
)
SELECT a.region_code,
       a.dropped_listing_count,
       a.avg_drop_pct,
       a.median_drop_pct,
       CASE WHEN a.dropped_listing_count >= 3 THEN a.max_drop_pct END AS max_drop_pct,
       CASE WHEN a.dropped_listing_count >= 3 THEN a.max_drop_abs END AS max_drop_abs,
       a.dropped_value,
       COALESCE(ac.total_active_listings, 0) AS total_active_listings,
       a.dropped_listing_count::float / NULLIF(ac.total_active_listings, 0) AS dropped_share
FROM agg a
LEFT JOIN active ac USING (region_code)
WHERE a.dropped_listing_count >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key
    ON mv_suburb_price_drops (region_code);

-- ---------------------------------------------------------------------------
-- 3. State + national rollup with the same address, privacy, sold-window and
--    recently-swept share semantics, plus catalog coverage.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_state_price_drops;
CREATE MATERIALIZED VIEW mv_state_price_drops AS
WITH ev AS (
    SELECT pl.state_code, e.source, pl.address_key AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    JOIN property_listings pl ON pl.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
      AND pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
), per_source AS (
    SELECT state_code, dedup_key, source,
           MAX(drop_pct) AS max_pct,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY state_code, dedup_key, source
), win AS (
    SELECT DISTINCT ON (state_code, dedup_key)
           state_code, dedup_key, max_pct, total_abs
    FROM per_source
    ORDER BY state_code, dedup_key, total_abs DESC, source
), d AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(*) AS dropped_count,
           AVG(max_pct) AS avg_drop_pct,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_drop_pct,
           MAX(max_pct) AS max_drop_pct,
           SUM(total_abs) AS dropped_value
    FROM win
    GROUP BY GROUPING SETS ((state_code), ())
), active_addresses AS (
    SELECT DISTINCT ON (pl.address_key)
           pl.state_code, pl.region_code, pl.address_key, pl.listing_status, pl.price
    FROM property_listings pl
    WHERE pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
    ORDER BY pl.address_key, pl.last_seen_at DESC, pl.source, pl.listing_id
), l AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(*) AS total_active_listings,
           COUNT(*) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS for_sale_count,
           COUNT(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS for_sale_priced,
           AVG(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS avg_asking,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
               FILTER (WHERE listing_status IN ('for_sale', 'under_offer') AND price IS NOT NULL) AS median_asking
    FROM active_addresses
    GROUP BY GROUPING SETS ((state_code), ())
), sold_transitions AS (
    SELECT DISTINCT ON (e.listing_pk)
           e.listing_pk, e.observed_at AS sold_at
    FROM property_price_events e
    WHERE e.event_type IN ('first_seen', 'status_change', 'relisted')
      AND e.listing_status = 'sold'
    ORDER BY e.listing_pk, e.observed_at DESC
), sold_addresses AS (
    SELECT DISTINCT ON (pl.address_key)
           pl.state_code, pl.region_code, pl.address_key, pl.price, st.sold_at
    FROM sold_transitions st
    JOIN property_listings pl ON pl.id = st.listing_pk
    WHERE pl.listing_status = 'sold'
      AND pl.price IS NOT NULL
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
      AND st.sold_at >= now() - interval '12 months'
    ORDER BY pl.address_key, st.sold_at DESC, pl.last_seen_at DESC, pl.source, pl.listing_id
), sold AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(*) AS sold_count,
           AVG(price) AS avg_sold,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_sold
    FROM sold_addresses
    GROUP BY GROUPING SETS ((state_code), ())
), tracked_addresses AS (
    SELECT state_code, region_code, address_key
    FROM active_addresses
    UNION
    SELECT state_code, region_code, address_key
    FROM sold_addresses
), u AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(DISTINCT region_code) AS suburbs_tracked
    FROM tracked_addresses
    GROUP BY GROUPING SETS ((state_code), ())
), catalog AS (
    -- The collector's coverage denominator, verbatim (drop_index.go
    -- queryCatalogSizes): every suburb the crawl has ever produced a listing
    -- for. Swept = any listing row of that suburb seen in the 14-day window,
    -- active or not, exactly as suburbDaysSQL admits a suburb to its panel.
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(DISTINCT sal_code) AS catalog_suburbs,
           COUNT(DISTINCT sal_code)
               FILTER (WHERE last_seen_at >= now() - interval '14 days') AS suburbs_swept_14d
    FROM property_listings
    WHERE sal_code IS NOT NULL
      AND state_code IS NOT NULL AND state_code <> '' AND state_code <> 'AU'
    GROUP BY GROUPING SETS ((state_code), ())
), states AS (
    -- A catalog state that has gone unswept must still appear (with coverage
    -- 0) so the board can say so, rather than drop out of the ranking unseen.
    SELECT state_code FROM u
    UNION
    SELECT state_code FROM catalog
)
SELECT s.state_code,
       COALESCE(d.dropped_count, 0) AS dropped_count,
       CASE WHEN d.dropped_count >= 3 THEN d.avg_drop_pct END AS avg_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.median_drop_pct END AS median_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.max_drop_pct END AS max_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.dropped_value END AS dropped_value,
       COALESCE(l.total_active_listings, 0) AS total_active_listings,
       COALESCE(d.dropped_count, 0)::float / NULLIF(COALESCE(l.total_active_listings, 0), 0) AS dropped_share,
       COALESCE(l.for_sale_count, 0) AS for_sale_count,
       COALESCE(l.for_sale_priced, 0) AS for_sale_priced,
       CASE WHEN COALESCE(l.for_sale_priced, 0) >= 3 THEN l.avg_asking END AS avg_asking,
       CASE WHEN COALESCE(l.for_sale_priced, 0) >= 3 THEN l.median_asking END AS median_asking,
       COALESCE(sold.sold_count, 0) AS sold_count,
       CASE WHEN sold.sold_count >= 3 THEN sold.avg_sold END AS avg_sold,
       CASE WHEN sold.sold_count >= 3 THEN sold.median_sold END AS median_sold,
       COALESCE(u.suburbs_tracked, 0) AS suburbs_tracked,
       COALESCE(c.suburbs_swept_14d, 0) AS suburbs_swept_14d,
       COALESCE(c.catalog_suburbs, 0) AS catalog_suburbs
FROM states s
LEFT JOIN u USING (state_code)
LEFT JOIN l USING (state_code)
LEFT JOIN d USING (state_code)
LEFT JOIN sold USING (state_code)
LEFT JOIN catalog c USING (state_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_state_price_drops_key
    ON mv_state_price_drops (state_code);

-- ---------------------------------------------------------------------------
-- 4. Agency rollup over recently-swept listings. Agent personal names stay
--    out of the aggregate (000109).
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_agency_stats;
CREATE MATERIALIZED VIEW mv_agency_stats AS
WITH base AS (
    SELECT DISTINCT ON (pl.source, pl.agency_id, pl.state_code, pl.address_key)
           pl.source, pl.agency_id, pl.agency_name, pl.state_code, pl.region_code,
           pl.price, pl.listing_status, pl.address_key
    FROM property_listings pl
    WHERE pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND pl.agency_id <> '' AND pl.agency_name <> ''
      AND pl.state_code IS NOT NULL AND pl.state_code <> ''
      AND NULLIF(pl.address_key, '') IS NOT NULL
    ORDER BY pl.source, pl.agency_id, pl.state_code, pl.address_key,
             pl.last_seen_at DESC, pl.listing_id
), ev AS (
    SELECT pl.source, pl.agency_id, pl.state_code, pl.address_key AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    JOIN property_listings pl ON pl.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
      AND pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND pl.agency_id <> '' AND pl.agency_name <> ''
      AND NULLIF(pl.address_key, '') IS NOT NULL
), per_addr AS (
    SELECT source, agency_id, state_code, dedup_key,
           MAX(drop_pct) AS max_pct,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY source, agency_id, state_code, dedup_key
), da AS (
    SELECT source, agency_id, state_code,
           COUNT(*) AS dropped_count,
           CASE WHEN COUNT(*) >= 3 THEN AVG(max_pct) END AS avg_drop_pct,
           CASE WHEN COUNT(*) >= 3 THEN SUM(total_abs) END AS total_drop_value
    FROM per_addr
    GROUP BY source, agency_id, state_code
), ag AS (
    SELECT source, agency_id, MAX(agency_name) AS agency_name, state_code,
           COUNT(*) AS active_listings,
           COUNT(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS priced_listings,
           AVG(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS avg_asking,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
               FILTER (WHERE listing_status IN ('for_sale', 'under_offer') AND price IS NOT NULL) AS median_asking,
           COUNT(DISTINCT region_code) AS suburbs_covered
    FROM base
    GROUP BY source, agency_id, state_code
)
SELECT ag.source, ag.agency_id, ag.agency_name, ag.state_code,
       ag.active_listings, ag.priced_listings,
       CASE WHEN ag.priced_listings >= 3 THEN ag.avg_asking END AS avg_asking,
       CASE WHEN ag.priced_listings >= 3 THEN ag.median_asking END AS median_asking,
       ag.suburbs_covered,
       COALESCE(da.dropped_count, 0) AS dropped_count,
       da.avg_drop_pct,
       da.total_drop_value,
       '{}'::text[] AS agent_names
FROM ag
LEFT JOIN da USING (source, agency_id, state_code)
WHERE ag.active_listings >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_agency_stats_key
    ON mv_agency_stats (source, agency_id, state_code);

-- ---------------------------------------------------------------------------
-- 5. Refresh bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS housing_mv_refresh (
    mv_name      text        PRIMARY KEY,
    -- now() of the refreshing transaction: the instant every now()-relative
    -- window inside the view (30-day drops, 14-day liveness, 12-month sold)
    -- was evaluated. Served as as_of.
    refreshed_at timestamptz NOT NULL,
    -- Newest crawl observation (price event or listing sighting) at refresh
    -- time. NULL for views not derived from the crawl. Served as data_through.
    data_through timestamptz
);

COMMENT ON TABLE housing_mv_refresh IS
    'One row per housing materialized view, written by refresh_housing_materialized_views() only after that view refreshed. Read by the price-drops RPCs as as_of / data_through.';

-- The views above were just built by CREATE MATERIALIZED VIEW, so they are
-- current as of this transaction.
INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
SELECT v.mv_name, now(),
       GREATEST((SELECT max(observed_at) FROM property_price_events),
                (SELECT max(last_seen_at) FROM property_listings))
FROM (VALUES ('mv_suburb_listing_stats'), ('mv_suburb_price_drops'),
             ('mv_state_price_drops'), ('mv_agency_stats')) AS v(mv_name)
ON CONFLICT (mv_name) DO UPDATE
    SET refreshed_at = EXCLUDED.refreshed_at,
        data_through = EXCLUDED.data_through;

-- Every view prod's function refreshes today (pg_proc, read 2026-09-23), each
-- in 000107's independently guarded concurrent -> blocking -> warning shape.
-- The bookkeeping write has its OWN guard: were it to share the view's block, a
-- failed INSERT would roll back the refresh it was recording.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_crawl_through timestamptz;
BEGIN
    -- Read before any refresh, so data_through can only understate what the
    -- crawl-derived views contain, never overstate it.
    BEGIN
        SELECT GREATEST((SELECT max(observed_at) FROM property_price_events),
                        (SELECT max(last_seen_at) FROM property_listings))
          INTO v_crawl_through;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Could not read the crawl horizon for housing_mv_refresh: %', SQLERRM;
        v_crawl_through := NULL;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_housing_headline concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_housing_headline;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_housing_headline', now(), NULL)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_housing_headline but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_housing_headline: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_price_drops concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_price_drops', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_price_drops but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_price_drops: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_listing_stats;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_listing_stats concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_listing_stats;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_listing_stats', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_listing_stats but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_listing_stats: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_price_drops;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_state_price_drops concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_state_price_drops;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_state_price_drops', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_state_price_drops but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_state_price_drops: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agency_stats;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_agency_stats concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_agency_stats;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_agency_stats', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_agency_stats but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_agency_stats: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_crime_latest;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_crime_latest concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_crime_latest;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_crime_latest', now(), NULL)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_crime_latest but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_crime_latest: %', SQLERRM;
    END;
END;
$$;

-- CREATE OR REPLACE resets the function's SET clauses, so re-arm the
-- belt-and-braces timeout exactly as 000107 does.
ALTER FUNCTION refresh_housing_materialized_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_housing_materialized_views() IS
    'Refreshes every housing MV independently (concurrent, blocking fallback, then warning), explicitly catching query_canceled so one timeout cannot starve later views, and records each successful refresh in housing_mv_refresh.';

-- ---------------------------------------------------------------------------
-- 6. Drop-index k-floor: a median over fewer than three dropped addresses is
--    withheld (NULL), not published as one listing's exact cut.
-- ---------------------------------------------------------------------------
ALTER TABLE housing_drop_index_daily ALTER COLUMN median_drop_pct DROP NOT NULL;

UPDATE housing_drop_index_daily
SET median_drop_pct = NULL
WHERE dropped_addresses < 3
  AND median_drop_pct IS NOT NULL;

COMMENT ON COLUMN housing_drop_index_daily.median_drop_pct IS
    'Median cut depth (0..1). NULL when fewer than 3 dropped addresses stand behind it: below that it is an individual listing''s exact cut.';

COMMIT;
