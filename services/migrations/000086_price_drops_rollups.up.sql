-- Price-drops rollups: state-level + agency-level derived aggregates, and a
-- hardened rebuild of the suburb drops MV.
--
-- Data-quality rules baked into every drop aggregate here (calibrated on
-- prod, 2026-07-21):
--   1. SANITY CAP drop_pct <= 0.40 — drops beyond 40% are listing typo
--      corrections (e.g. $7,500,000 -> $749,999: an extra-zero fix), not real
--      vendor discounts. Real drops cluster under 25%.
--   2. ADDRESS DEDUP — ~6.5k listing rows are cross-listed on BOTH portals;
--      every aggregate (numerators AND denominators) counts each physical
--      address once (fallback key source:listing_id for the ~4% of rows
--      without an address_key). Per-address dollar totals come from the single
--      portal that observed the most cutting, so the same real cut seen on
--      both portals is never double-counted.
--   3. 'AU' GUARD — the state MV keys its national row as 'AU'; a junk crawler
--      row with a literal state_code='AU' would collide with it and abort the
--      unique-index refresh, so those rows are excluded outright.
--
-- LICENCE: all three MVs are DERIVED AGGREGATES over proprietary-tos-restricted
-- rows and are the only publishable surface (same posture as 000076/000077).
-- mv_agency_stats additionally suppresses drop depth/value until an agency has
-- >= 3 dropped addresses, so no published figure can be reversed into a single
-- listing's exact numbers.

-- ---------------------------------------------------------------------------
-- 1. Rebuild mv_suburb_price_drops with the cap + address dedup (+dropped_value).
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_price_drops;
CREATE MATERIALIZED VIEW mv_suburb_price_drops AS
WITH ev AS (
    SELECT e.region_code, e.source,
           COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id) AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
), per_source AS (  -- one portal's view of one address's cutting in the window
    SELECT region_code, dedup_key, source,
           MAX(drop_pct) AS max_pct,
           MAX(drop_abs) AS max_abs,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY region_code, dedup_key, source
), win AS (  -- one row per address: the portal that observed the most cutting
    SELECT DISTINCT ON (dedup_key)
           region_code, dedup_key, max_pct, max_abs, total_abs
    FROM per_source
    ORDER BY dedup_key, total_abs DESC
), agg AS (
    SELECT region_code,
        COUNT(*)                                             AS dropped_listing_count,
        AVG(max_pct)                                         AS avg_drop_pct,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_drop_pct,
        MAX(max_pct)                                         AS max_drop_pct,
        MAX(max_abs)                                         AS max_drop_abs,
        SUM(total_abs)                                       AS dropped_value
    FROM win
    GROUP BY region_code
), active AS (  -- address-deduped so dropped_share is a like-for-like ratio
    SELECT region_code,
           COUNT(DISTINCT COALESCE(NULLIF(address_key, ''), source || ':' || listing_id))
               AS total_active_listings
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
       a.dropped_value,
       COALESCE(ac.total_active_listings, 0) AS total_active_listings,
       a.dropped_listing_count::float / NULLIF(ac.total_active_listings, 0) AS dropped_share
FROM agg a
LEFT JOIN active ac USING (region_code)
WHERE a.dropped_listing_count >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key
    ON mv_suburb_price_drops (region_code);

-- ---------------------------------------------------------------------------
-- 2. State-level rollup (plus an 'AU' national row) over ALL collected listing
--    pricing data: drop stats + asking/sold aggregates per state.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_state_price_drops AS
WITH ev AS (
    SELECT pl.state_code, e.source,
           COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id) AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    JOIN property_listings pl ON pl.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
), per_source AS (
    SELECT state_code, dedup_key, source,
           MAX(drop_pct) AS max_pct,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY state_code, dedup_key, source
), win AS (
    SELECT DISTINCT ON (dedup_key)
           state_code, dedup_key, max_pct, total_abs
    FROM per_source
    ORDER BY dedup_key, total_abs DESC
), d AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
        COUNT(*)                                             AS dropped_count,
        AVG(max_pct)                                         AS avg_drop_pct,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_drop_pct,
        MAX(max_pct)                                         AS max_drop_pct,
        SUM(total_abs)                                       AS dropped_value
    FROM win
    GROUP BY GROUPING SETS ((state_code), ())
), l AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
        -- address-deduped so dropped_share is a like-for-like ratio
        COUNT(DISTINCT COALESCE(NULLIF(address_key, ''), source || ':' || listing_id))
            FILTER (WHERE is_active)                           AS total_active_listings,
        COUNT(*) FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer'))
                                                               AS for_sale_count,
        COUNT(price) FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer'))
                                                               AS for_sale_priced,
        AVG(price) FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer'))
                                                               AS avg_asking,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
            FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer') AND price IS NOT NULL)
                                                               AS median_asking,
        COUNT(*) FILTER (WHERE listing_status = 'sold' AND price IS NOT NULL)
                                                               AS sold_count,
        AVG(price) FILTER (WHERE listing_status = 'sold')      AS avg_sold,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
            FILTER (WHERE listing_status = 'sold' AND price IS NOT NULL)
                                                               AS median_sold,
        COUNT(DISTINCT region_code)                            AS suburbs_tracked
    FROM property_listings
    WHERE state_code IS NOT NULL AND state_code <> '' AND state_code <> 'AU'
    GROUP BY GROUPING SETS ((state_code), ())
)
SELECT l.state_code,
       COALESCE(d.dropped_count, 0)   AS dropped_count,
       d.avg_drop_pct,
       d.median_drop_pct,
       d.max_drop_pct,
       COALESCE(d.dropped_value, 0)   AS dropped_value,
       l.total_active_listings,
       COALESCE(d.dropped_count, 0)::float / NULLIF(l.total_active_listings, 0) AS dropped_share,
       l.for_sale_count,
       l.for_sale_priced,
       l.avg_asking,
       l.median_asking,
       l.sold_count,
       l.avg_sold,
       l.median_sold,
       l.suburbs_tracked
FROM l
LEFT JOIN d USING (state_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_state_price_drops_key
    ON mv_state_price_drops (state_code);

-- ---------------------------------------------------------------------------
-- 3. Agency rollup: which agencies are discounting, at what depth, and where.
--    Aggregates only (floor: >=3 active listings); agency_id is PER-PORTAL —
--    no cross-portal entity resolution, so the key is (source, agency_id).
--    Drop DEPTH and VALUE are suppressed (NULL/0) until the agency has >= 3
--    dropped addresses — below that they equal an identifiable individual
--    listing's exact numbers. agent_names is a small display sample, not a
--    roster; the read RPC sits behind the same kill switch as the per-listing
--    surfaces (HOUSING_DROP_LISTINGS_ENABLED).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agency_stats AS
WITH base AS (
    SELECT source, agency_id, agency_name, state_code, region_code,
           price, is_active, listing_status, agent_names
    FROM property_listings
    WHERE agency_id <> '' AND agency_name <> ''
      AND state_code IS NOT NULL AND state_code <> ''
), ev AS (
    SELECT pl.source, pl.agency_id, pl.state_code,
           COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id) AS dedup_key,
           e.drop_pct, e.drop_abs
    FROM property_price_events e
    JOIN property_listings pl ON pl.id = e.listing_pk
    WHERE e.event_type = 'price_drop'
      AND e.observed_at >= now() - interval '30 days'
      AND e.drop_pct IS NOT NULL
      AND e.drop_pct <= 0.40
      AND pl.agency_id <> '' AND pl.agency_name <> ''
), per_addr AS (  -- agency key includes source, so no cross-portal double count
    SELECT source, agency_id, state_code, dedup_key,
           MAX(drop_pct) AS max_pct,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY source, agency_id, state_code, dedup_key
), da AS (
    SELECT source, agency_id, state_code,
        COUNT(*)                            AS dropped_count,
        CASE WHEN COUNT(*) >= 3 THEN AVG(max_pct) END       AS avg_drop_pct,
        CASE WHEN COUNT(*) >= 3 THEN SUM(total_abs) END     AS total_drop_value
    FROM per_addr
    GROUP BY source, agency_id, state_code
), ag AS (
    SELECT source, agency_id, MAX(agency_name) AS agency_name, state_code,
        COUNT(*) FILTER (WHERE is_active)      AS active_listings,
        COUNT(price) FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer'))
                                               AS priced_listings,
        AVG(price) FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer'))
                                               AS avg_asking,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
            FILTER (WHERE is_active AND listing_status IN ('for_sale', 'under_offer') AND price IS NOT NULL)
                                               AS median_asking,
        COUNT(DISTINCT region_code)            AS suburbs_covered
    FROM base
    GROUP BY source, agency_id, state_code
), agents AS (
    SELECT source, agency_id, state_code,
           (ARRAY_AGG(DISTINCT a))[1:6] AS agent_names
    FROM base, LATERAL UNNEST(base.agent_names) AS a
    GROUP BY source, agency_id, state_code
)
SELECT ag.source, ag.agency_id, ag.agency_name, ag.state_code,
       ag.active_listings, ag.priced_listings, ag.avg_asking, ag.median_asking,
       ag.suburbs_covered,
       COALESCE(da.dropped_count, 0)    AS dropped_count,
       da.avg_drop_pct,
       COALESCE(da.total_drop_value, 0) AS total_drop_value,
       COALESCE(agents.agent_names, '{}') AS agent_names
FROM ag
LEFT JOIN da USING (source, agency_id, state_code)
LEFT JOIN agents USING (source, agency_id, state_code)
WHERE ag.active_listings >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_agency_stats_key
    ON mv_agency_stats (source, agency_id, state_code);

-- ---------------------------------------------------------------------------
-- 4. Fold the new MVs into the shared housing refresh (guarded fallback like
--    000076/000077 so first-run/blocking refresh still works).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_listing_stats;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_listing_stats;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_state_price_drops;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agency_stats;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_agency_stats;
    END;
END;
$$ LANGUAGE plpgsql;
