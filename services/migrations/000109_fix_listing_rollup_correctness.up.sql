-- Make every listing-derived aggregate use physical addresses as its unit,
-- suppress proprietary price statistics below k=3, and bound sold statistics
-- to transitions observed in the last 12 months.
--
-- Rows without address_key are deliberately excluded: source:listing_id is a
-- portal identity, not a physical-address identity, and double-counts the same
-- home when both portals fail address extraction. Counts remain publishable;
-- asking/sold/drop price figures are NULL whenever fewer than three addresses
-- contribute. Thirty-day drop shares use current-active addresses for both the
-- numerator and denominator, making the numerator a true subset.

-- ---------------------------------------------------------------------------
-- 1. Per-suburb asking and 12-month sold prices, address-deduped and k-anon.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_listing_stats;
CREATE MATERIALIZED VIEW mv_suburb_listing_stats AS
WITH asking_addresses AS (
    SELECT DISTINCT ON (pl.address_key)
           pl.region_code, pl.address_key, pl.price
    FROM property_listings pl
    WHERE pl.is_active
      AND pl.listing_status IN ('for_sale', 'under_offer')
      AND NULLIF(pl.address_key, '') IS NOT NULL
    ORDER BY pl.address_key, pl.last_seen_at DESC, pl.source
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
    ORDER BY pl.address_key, st.sold_at DESC, pl.last_seen_at DESC, pl.source
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
-- 2. Per-suburb 30-day drops. Only currently-active, addressable homes enter
--    the numerator; the denominator uses the same current-active address unit.
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
      AND NULLIF(pl.address_key, '') IS NOT NULL
), per_source AS (
    SELECT region_code, dedup_key, source,
           MAX(drop_pct) AS max_pct,
           SUM(drop_abs) AS total_abs
    FROM ev
    GROUP BY region_code, dedup_key, source
), win AS (
    SELECT DISTINCT ON (region_code, dedup_key)
           region_code, dedup_key, max_pct, total_abs
    FROM per_source
    ORDER BY region_code, dedup_key, total_abs DESC, source
), agg AS (
    SELECT region_code,
           COUNT(*) AS dropped_listing_count,
           AVG(max_pct) AS avg_drop_pct,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_drop_pct,
           SUM(total_abs) AS dropped_value
    FROM win
    GROUP BY region_code
), active AS (
    SELECT region_code, COUNT(DISTINCT address_key) AS total_active_listings
    FROM property_listings
    WHERE is_active AND NULLIF(address_key, '') IS NOT NULL
    GROUP BY region_code
)
SELECT a.region_code,
       a.dropped_listing_count,
       a.avg_drop_pct,
       a.median_drop_pct,
       NULL::double precision AS max_drop_pct,
       NULL::double precision AS max_drop_abs,
       a.dropped_value,
       COALESCE(ac.total_active_listings, 0) AS total_active_listings,
       a.dropped_listing_count::float / NULLIF(ac.total_active_listings, 0) AS dropped_share
FROM agg a
LEFT JOIN active ac USING (region_code)
WHERE a.dropped_listing_count >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key
    ON mv_suburb_price_drops (region_code);

-- ---------------------------------------------------------------------------
-- 3. State + national rollup with the same address, privacy, sold-window, and
--    current-active share semantics.
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
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
    ORDER BY pl.address_key, pl.last_seen_at DESC, pl.source
), l AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(*) AS total_active_listings,
           COUNT(*) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS for_sale_count,
           COUNT(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS for_sale_priced,
           AVG(price) FILTER (WHERE listing_status IN ('for_sale', 'under_offer')) AS avg_asking,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
               FILTER (WHERE listing_status IN ('for_sale', 'under_offer') AND price IS NOT NULL) AS median_asking,
           COUNT(DISTINCT region_code) AS suburbs_tracked
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
           pl.state_code, pl.address_key, pl.price, st.sold_at
    FROM sold_transitions st
    JOIN property_listings pl ON pl.id = st.listing_pk
    WHERE pl.listing_status = 'sold'
      AND pl.price IS NOT NULL
      AND NULLIF(pl.address_key, '') IS NOT NULL
      AND pl.state_code IS NOT NULL AND pl.state_code <> '' AND pl.state_code <> 'AU'
      AND st.sold_at >= now() - interval '12 months'
    ORDER BY pl.address_key, st.sold_at DESC, pl.last_seen_at DESC, pl.source
), sold AS (
    SELECT COALESCE(state_code, 'AU') AS state_code,
           COUNT(*) AS sold_count,
           AVG(price) AS avg_sold,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_sold
    FROM sold_addresses
    GROUP BY GROUPING SETS ((state_code), ())
)
SELECT l.state_code,
       COALESCE(d.dropped_count, 0) AS dropped_count,
       CASE WHEN d.dropped_count >= 3 THEN d.avg_drop_pct END AS avg_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.median_drop_pct END AS median_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.max_drop_pct END AS max_drop_pct,
       CASE WHEN d.dropped_count >= 3 THEN d.dropped_value END AS dropped_value,
       l.total_active_listings,
       COALESCE(d.dropped_count, 0)::float / NULLIF(l.total_active_listings, 0) AS dropped_share,
       l.for_sale_count,
       l.for_sale_priced,
       CASE WHEN l.for_sale_priced >= 3 THEN l.avg_asking END AS avg_asking,
       CASE WHEN l.for_sale_priced >= 3 THEN l.median_asking END AS median_asking,
       COALESCE(sold.sold_count, 0) AS sold_count,
       CASE WHEN sold.sold_count >= 3 THEN sold.avg_sold END AS avg_sold,
       CASE WHEN sold.sold_count >= 3 THEN sold.median_sold END AS median_sold,
       l.suburbs_tracked
FROM l
LEFT JOIN d USING (state_code)
LEFT JOIN sold USING (state_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_state_price_drops_key
    ON mv_state_price_drops (state_code);

-- ---------------------------------------------------------------------------
-- 4. Agency rollup. Agent personal names are removed from the aggregate MV;
--    the existing flag-gated listing drill-down remains their only read path.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_agency_stats;
CREATE MATERIALIZED VIEW mv_agency_stats AS
WITH base AS (
    SELECT DISTINCT ON (pl.source, pl.agency_id, pl.state_code, pl.address_key)
           pl.source, pl.agency_id, pl.agency_name, pl.state_code, pl.region_code,
           pl.price, pl.listing_status, pl.address_key
    FROM property_listings pl
    WHERE pl.is_active
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
