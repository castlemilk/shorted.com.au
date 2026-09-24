-- Council price drops as a materialized view, and an index for the council
-- index's data_through, so ListCouncils stops paying for a live crawl scan.
--
-- 1. COLD LATENCY. ListCouncils took 11s for NSW on its first call after a
--    deploy (VIC 4s), then 0.8s; locally 12-100ms. pg_stat_statements on prod
--    (read 2026-09-24): the council price-drops pooling query peaked at 5.8s,
--    the summary query at 2.8s, the hazard rollup at 0.9s — run in sequence,
--    that is the 11s. The drops query is the dominant cost: its `live` step
--    walks house_price_regions -> property_listings for every crawled suburb
--    of the state, 2,568 index probes and 18,640 buffers of a 56MB table the
--    crawl rewrites daily, so its pages are rarely cached when a council page
--    is first requested. EXPLAIN (ANALYZE, BUFFERS) NSW, warm: 276ms / 19,794
--    buffers. The view below is that query, computed once per refresh; the
--    read is an index range scan over a few hundred rows.
--
--    The definition is the council store's live query (postgres_councils.go
--    councilDropsQuery) with the state/council filters lifted into columns and
--    nothing else changed: the same address-deduped winner per address, the
--    same 30-day event window and 40% sanity cap, the same 14-day "active"
--    gate (000124), the same GROUPING SETS council-total row, and the same
--    k>=3 floor on a named suburb's median. The council-level k>=3 floor
--    stays in Go (aggregateCouncilDrops), exactly where it was. Every now()
--    in the view is the refreshing transaction's, which housing_mv_refresh
--    records as refreshed_at: the API serves that as as_of, the same
--    "computed at" meaning decision 9 gives every other drops read.
--
--    The council total is keyed sal_code = '' (not NULL) so the UNIQUE index
--    REFRESH ... CONCURRENTLY needs holds every row.
--
-- 2. data_through. The summary's newest-period subquery reads every public
--    lga_series row of a council (255 on average, 3,380 buffers for NSW)
--    because idx_lga_series_measure_latest leads with measure. A partial index
--    on (lga_code24, period DESC) over the public rows answers max(period)
--    from one index entry per council (local: 6,138 -> 2,363 buffers).
--
-- Hand-applied (prod does not run `migrate up`): session pooler 5432, one
-- transaction, timeout disarmed in-session because Supavisor drops
-- PGOPTIONS. Replay-safe: CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- ON CONFLICT, and the view is only built when absent, so a replay never
-- rebuilds it. The refresh function is 000124's body verbatim with one more
-- guarded block appended; verified identical to prod's pg_proc on 2026-09-24.

BEGIN;

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1. mv_council_price_drops: one row per (council, crawled dominant suburb)
--    plus one council-total row (sal_code '').
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_council_price_drops AS
WITH sub AS (
    SELECT l.state_code, sl.lga_code24, sl.sal_code, r.region_code
    FROM suburb_lga sl
    JOIN lga l ON l.lga_code24 = sl.lga_code24
    JOIN house_price_regions r ON r.sal_code = sl.sal_code
), live AS (
    SELECT sub.state_code, sub.lga_code24, sub.sal_code, pl.id, pl.address_key, pl.last_seen_at
    FROM sub
    JOIN property_listings pl ON pl.region_code = sub.region_code
    WHERE pl.is_active
      AND pl.last_seen_at >= now() - interval '14 days'
      AND NULLIF(pl.address_key, '') IS NOT NULL
), per_source AS (
    SELECT lv.lga_code24, lv.sal_code, lv.address_key, e.source,
           max(e.drop_pct) AS max_pct, sum(e.drop_abs) AS total_abs, max(e.observed_at) AS cut_at
    FROM live lv
    JOIN property_price_events e ON e.listing_pk = lv.id
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
    GROUP BY lv.lga_code24, lv.sal_code, lv.address_key, e.source
), cut AS (
    SELECT DISTINCT ON (sal_code, address_key) lga_code24, sal_code, address_key, max_pct, cut_at
    FROM per_source
    ORDER BY sal_code, address_key, total_abs DESC, source
), tracked AS (
    SELECT state_code, lga_code24, sal_code, count(DISTINCT address_key) AS n, max(last_seen_at) AS seen_at
    FROM live
    GROUP BY GROUPING SETS ((state_code, lga_code24, sal_code), (state_code, lga_code24))
), dropped AS (
    SELECT lga_code24, sal_code, count(DISTINCT address_key) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_pct,
           max(cut_at) AS cut_at
    FROM cut
    GROUP BY GROUPING SETS ((lga_code24, sal_code), (lga_code24))
)
SELECT t.state_code,
       t.lga_code24,
       COALESCE(t.sal_code, '') AS sal_code,
       COALESCE(d.sal_name, '') AS sal_name,
       COALESCE(d.postcode, '') AS postcode,
       COALESCE(x.n, 0)::bigint AS dropped,
       t.n::bigint AS tracked,
       CASE WHEN x.n >= 3 THEN x.median_pct END AS median_drop_pct,
       GREATEST(t.seen_at, x.cut_at) AS data_through
FROM tracked t
LEFT JOIN dropped x ON x.lga_code24 = t.lga_code24 AND x.sal_code IS NOT DISTINCT FROM t.sal_code
LEFT JOIN suburb_demographics d ON d.sal_code = t.sal_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_council_price_drops_key
    ON mv_council_price_drops (state_code, lga_code24, sal_code);

COMMENT ON MATERIALIZED VIEW mv_council_price_drops IS
    'Asking-price cuts per council (sal_code '''' = council total) and per crawled dominant suburb, from the crawl tables: address-deduped, 30-day events, 40% cap, 14-day active gate, suburb median withheld under 3 cuts. Aggregates only. Refreshed by refresh_housing_materialized_views(); as_of = housing_mv_refresh.refreshed_at.';

-- Built just now (or earlier, on a replay): record it only when absent, so a
-- replay never claims a refresh that did not happen.
INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
VALUES ('mv_council_price_drops', now(),
        GREATEST((SELECT max(observed_at) FROM property_price_events),
                 (SELECT max(last_seen_at) FROM property_listings)))
ON CONFLICT (mv_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The council index's data_through: newest public period per council.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lga_series_public_latest
    ON lga_series (lga_code24, period DESC)
    WHERE source_licence <> 'proprietary-tos-restricted';

-- ---------------------------------------------------------------------------
-- 3. Refresh function: 000124's body verbatim, plus mv_council_price_drops in
--    the same independently guarded concurrent -> blocking -> warning shape,
--    recording its refresh with the crawl horizon like every crawl view.
-- ---------------------------------------------------------------------------
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

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_council_price_drops;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_council_price_drops concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_council_price_drops;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_council_price_drops', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_council_price_drops but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_council_price_drops: %', SQLERRM;
    END;
END;
$$;

-- CREATE OR REPLACE resets the function's SET clauses, so re-arm the
-- belt-and-braces timeout exactly as 000107 and 000124 do.
ALTER FUNCTION refresh_housing_materialized_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_housing_materialized_views() IS
    'Refreshes every housing MV independently (concurrent, blocking fallback, then warning), explicitly catching query_canceled so one timeout cannot starve later views, and records each successful refresh in housing_mv_refresh.';

COMMIT;
