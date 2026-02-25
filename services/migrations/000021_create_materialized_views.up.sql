-- Migration 000021: Create Materialized Views
-- Purpose: Create mv_top_shorts, mv_treemap_data, mv_watchlist_defaults for performance
-- These views are already queried by the Go backend with fallback paths.
-- Expected improvements: GetTopShorts ~2300ms->~6ms, GetTreeMap ~500ms->~3ms

-- =====================================================
-- mv_treemap_data: Pre-computed treemap data per period
-- =====================================================

DROP MATERIALIZED VIEW IF EXISTS mv_treemap_data CASCADE;

CREATE MATERIALIZED VIEW mv_treemap_data AS
WITH latest_date AS (
    SELECT MAX("DATE") as max_date FROM shorts
),
period_configs AS (
    SELECT '3 months'::interval as period_interval, '3m' as period_name
    UNION ALL SELECT '6 months'::interval, '6m'
    UNION ALL SELECT '1 year'::interval, '1y'
    UNION ALL SELECT '2 years'::interval, '2y'
    UNION ALL SELECT '5 years'::interval, '5y'
    UNION ALL SELECT '10 years'::interval, 'max'
),
period_data AS (
    SELECT
        pc.period_name,
        s."PRODUCT_CODE",
        s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
        s."DATE",
        ld.max_date,
        ROW_NUMBER() OVER (PARTITION BY pc.period_name, s."PRODUCT_CODE" ORDER BY s."DATE" DESC) AS rnk_desc,
        ROW_NUMBER() OVER (PARTITION BY pc.period_name, s."PRODUCT_CODE" ORDER BY s."DATE" ASC) AS rnk_asc
    FROM
        shorts s
    CROSS JOIN period_configs pc
    CROSS JOIN latest_date ld
    WHERE
        s."DATE" >= ld.max_date - pc.period_interval
        AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
),
latest_data AS (
    SELECT
        period_name,
        "PRODUCT_CODE",
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS latest_short_position,
        "DATE" AS latest_date
    FROM
        period_data
    WHERE
        rnk_desc = 1
        AND "DATE" >= max_date - INTERVAL '6 months'
),
earliest_data AS (
    SELECT
        period_name,
        "PRODUCT_CODE",
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS earliest_short_position
    FROM
        period_data
    WHERE
        rnk_asc = 1
),
percentage_change AS (
    SELECT
        ld.period_name,
        ld."PRODUCT_CODE",
        ld.latest_short_position,
        ld.latest_date,
        ed.earliest_short_position,
        CASE
            WHEN ed.earliest_short_position = 0 OR ed.earliest_short_position IS NULL THEN NULL
            ELSE ((ld.latest_short_position - ed.earliest_short_position) / ed.earliest_short_position) * 100
        END AS percentage_change
    FROM
        latest_data ld
    LEFT JOIN
        earliest_data ed
    ON
        ld.period_name = ed.period_name
        AND ld."PRODUCT_CODE" = ed."PRODUCT_CODE"
)
SELECT
    pc.period_name,
    cm.industry,
    pc."PRODUCT_CODE" as product_code,
    cm.company_name,
    pc.latest_short_position as current_short_position,
    pc.earliest_short_position,
    pc.percentage_change,
    pc.latest_date,
    NOW() as last_refreshed
FROM
    percentage_change pc
JOIN
    "company-metadata" cm
ON
    pc."PRODUCT_CODE" = cm.stock_code
WHERE
    cm.industry IS NOT NULL
    AND pc.latest_short_position > 0;

-- Unique index required for CONCURRENTLY refresh
CREATE UNIQUE INDEX idx_mv_treemap_unique
ON mv_treemap_data (period_name, product_code);

CREATE INDEX idx_mv_treemap_period_industry
ON mv_treemap_data (period_name, industry, percentage_change DESC NULLS LAST);

CREATE INDEX idx_mv_treemap_period_current
ON mv_treemap_data (period_name, current_short_position DESC);

CREATE INDEX idx_mv_treemap_product
ON mv_treemap_data (product_code, period_name);

-- =====================================================
-- mv_top_shorts: Current top shorted stocks with metadata
-- =====================================================

DROP MATERIALIZED VIEW IF EXISTS mv_top_shorts CASCADE;

CREATE MATERIALIZED VIEW mv_top_shorts AS
WITH latest_date AS (
    SELECT MAX("DATE") as max_date FROM shorts
),
recent_shorts AS (
    SELECT DISTINCT ON ("PRODUCT_CODE")
        s."PRODUCT_CODE",
        s."PRODUCT",
        s."DATE",
        s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as current_percent,
        s."REPORTED_SHORT_POSITIONS",
        s."TOTAL_PRODUCT_IN_ISSUE"
    FROM shorts s
    CROSS JOIN latest_date ld
    WHERE s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
        AND s."DATE" > ld.max_date - INTERVAL '1 month'
        AND s."PRODUCT" NOT ILIKE '%DEFERRED SETTLEMENT%'
        AND s."PRODUCT" NOT ILIKE '%DEFERRED%'
    ORDER BY s."PRODUCT_CODE", s."DATE" DESC
)
SELECT
    rs."PRODUCT_CODE" as product_code,
    rs."PRODUCT" as product_name,
    rs."DATE" as latest_date,
    rs.current_percent,
    rs."REPORTED_SHORT_POSITIONS" as reported_short_positions,
    rs."TOTAL_PRODUCT_IN_ISSUE" as total_in_issue,
    cm.company_name,
    cm.industry,
    cm.logo_gcs_url,
    NOW() as last_refreshed
FROM recent_shorts rs
LEFT JOIN "company-metadata" cm ON rs."PRODUCT_CODE" = cm.stock_code
ORDER BY rs.current_percent DESC;

CREATE UNIQUE INDEX idx_mv_top_shorts_product ON mv_top_shorts (product_code);
CREATE INDEX idx_mv_top_shorts_percent ON mv_top_shorts (current_percent DESC);
CREATE INDEX idx_mv_top_shorts_industry ON mv_top_shorts (industry, current_percent DESC);

-- =====================================================
-- mv_watchlist_defaults: Pre-computed default watchlist
-- =====================================================

DROP MATERIALIZED VIEW IF EXISTS mv_watchlist_defaults CASCADE;

CREATE MATERIALIZED VIEW mv_watchlist_defaults AS
WITH default_stocks AS (
    SELECT unnest(ARRAY['CBA', 'BHP', 'CSL', 'WBC', 'ANZ', 'RIO', 'WOW', 'TLS']) as stock_code
),
latest_prices AS (
    SELECT DISTINCT ON (sp.stock_code)
        sp.stock_code,
        sp.date as price_date,
        sp.close as latest_price,
        sp.open,
        sp.high,
        sp.low,
        sp.volume
    FROM stock_prices sp
    INNER JOIN default_stocks ds ON sp.stock_code = ds.stock_code
    ORDER BY sp.stock_code, sp.date DESC
),
price_changes AS (
    SELECT
        lp.stock_code,
        lp.latest_price,
        lp.open,
        lp.high,
        lp.low,
        lp.volume,
        lp.price_date,
        prev.close as previous_close,
        CASE
            WHEN prev.close > 0 THEN ((lp.latest_price - prev.close) / prev.close) * 100
            ELSE 0
        END as change_percent,
        lp.latest_price - COALESCE(prev.close, lp.latest_price) as change_amount
    FROM latest_prices lp
    LEFT JOIN LATERAL (
        SELECT close
        FROM stock_prices
        WHERE stock_code = lp.stock_code
            AND date < lp.price_date
        ORDER BY date DESC
        LIMIT 1
    ) prev ON true
),
latest_shorts AS (
    SELECT DISTINCT ON (s."PRODUCT_CODE")
        s."PRODUCT_CODE" as stock_code,
        s."DATE" as shorts_date,
        s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as short_percent,
        s."REPORTED_SHORT_POSITIONS",
        s."TOTAL_PRODUCT_IN_ISSUE"
    FROM shorts s
    INNER JOIN default_stocks ds ON s."PRODUCT_CODE" = ds.stock_code
    ORDER BY s."PRODUCT_CODE", s."DATE" DESC
)
SELECT
    ds.stock_code,
    cm.company_name,
    cm.industry,
    cm.logo_gcs_url,
    pc.latest_price,
    pc.open,
    pc.high,
    pc.low,
    pc.volume,
    pc.previous_close,
    pc.change_percent,
    pc.change_amount,
    pc.price_date,
    ls.short_percent,
    ls."REPORTED_SHORT_POSITIONS" as reported_short_positions,
    ls."TOTAL_PRODUCT_IN_ISSUE" as total_in_issue,
    ls.shorts_date,
    NOW() as last_refreshed
FROM default_stocks ds
LEFT JOIN "company-metadata" cm ON ds.stock_code = cm.stock_code
LEFT JOIN price_changes pc ON ds.stock_code = pc.stock_code
LEFT JOIN latest_shorts ls ON ds.stock_code = ls.stock_code;

CREATE UNIQUE INDEX idx_mv_watchlist_defaults_stock ON mv_watchlist_defaults (stock_code);

-- =====================================================
-- refresh_all_materialized_views() function
-- =====================================================

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_treemap_data...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_treemap_data concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_treemap_data;
    END;

    RAISE NOTICE 'Refreshing mv_top_shorts...';
    REFRESH MATERIALIZED VIEW mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'All materialized views refreshed successfully';
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- Analyze for query planner
ANALYZE mv_treemap_data;
ANALYZE mv_top_shorts;
ANALYZE mv_watchlist_defaults;
