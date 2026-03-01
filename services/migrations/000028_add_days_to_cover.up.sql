-- Migration 000028: Add "Days to Cover" metric to screener and top shorts MVs
-- days_to_cover = reported_short_positions / avg_daily_volume_20d
-- This is the #1 metric short squeeze hunters look for

-- =====================================================
-- Recreate mv_screener_data with days_to_cover
-- =====================================================

DROP MATERIALIZED VIEW IF EXISTS mv_screener_data CASCADE;

CREATE MATERIALIZED VIEW mv_screener_data AS
WITH latest_shorts AS (
    SELECT DISTINCT ON ("PRODUCT_CODE")
        "PRODUCT_CODE" AS stock_code,
        "PRODUCT" AS product_name,
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS short_pct,
        "REPORTED_SHORT_POSITIONS" AS reported_short_positions,
        "DATE" AS short_date
    FROM shorts
    WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
    ORDER BY "PRODUCT_CODE", "DATE" DESC
),
short_change AS (
    -- 4-week (28 day) change in short position
    SELECT
        ls.stock_code,
        ls.short_pct - COALESCE(prev."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", ls.short_pct) AS short_pct_change_4w
    FROM latest_shorts ls
    LEFT JOIN LATERAL (
        SELECT "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
        FROM shorts
        WHERE "PRODUCT_CODE" = ls.stock_code
          AND "DATE" <= ls.short_date - INTERVAL '28 days'
        ORDER BY "DATE" DESC
        LIMIT 1
    ) prev ON true
),
latest_price AS (
    SELECT DISTINCT ON (stock_code)
        stock_code,
        close AS latest_price,
        volume AS latest_volume,
        date AS price_date
    FROM stock_prices
    ORDER BY stock_code, date DESC
),
avg_volume AS (
    -- 20-trading-day average volume (look back ~30 calendar days to capture 20 trading days)
    SELECT
        stock_code,
        AVG(volume)::bigint AS avg_volume_20d
    FROM stock_prices
    WHERE date >= CURRENT_DATE - INTERVAL '35 days'
      AND volume > 0
    GROUP BY stock_code
    HAVING COUNT(*) >= 5
),
price_change AS (
    -- 1-month price change %
    SELECT
        lp.stock_code,
        CASE
            WHEN prev.close IS NOT NULL AND prev.close > 0
            THEN ((lp.latest_price - prev.close) / prev.close) * 100
            ELSE 0
        END AS price_change_1m
    FROM latest_price lp
    LEFT JOIN LATERAL (
        SELECT close
        FROM stock_prices
        WHERE stock_code = lp.stock_code
          AND date <= lp.price_date - INTERVAL '30 days'
        ORDER BY date DESC
        LIMIT 1
    ) prev ON true
),
director_summary AS (
    -- 90-day director trade summary
    SELECT
        stock_code,
        COALESCE(SUM(CASE WHEN trade_type = 'buy' THEN COALESCE(total_value, 0) ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN trade_type = 'sell' THEN COALESCE(total_value, 0) ELSE 0 END), 0) AS net_director_buy_value,
        COUNT(*) FILTER (WHERE trade_type = 'buy') AS director_buy_count,
        COUNT(*) FILTER (WHERE trade_type = 'sell') AS director_sell_count
    FROM director_trades
    WHERE trade_date >= CURRENT_DATE - INTERVAL '90 days'
    GROUP BY stock_code
),
news_summary AS (
    -- 30-day news summary
    SELECT
        stock_code,
        COUNT(*) AS news_count_30d,
        AVG(CASE
            WHEN sentiment = 'positive' THEN 1.0
            WHEN sentiment = 'negative' THEN -1.0
            ELSE 0.0
        END) AS avg_sentiment,
        COUNT(*) FILTER (WHERE is_price_sensitive) AS price_sensitive_count
    FROM news_articles
    WHERE published_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    GROUP BY stock_code
),
dividend_summary AS (
    -- Trailing 12-month dividends
    SELECT
        stock_code,
        SUM(amount_per_share) AS trailing_12m_dividend,
        AVG(franking_percentage) AS avg_franking_pct
    FROM dividend_history
    WHERE ex_date >= CURRENT_DATE - INTERVAL '12 months'
    GROUP BY stock_code
)
SELECT
    ls.stock_code,
    ls.product_name,
    COALESCE(cm.company_name, ls.product_name) AS company_name,
    COALESCE(cm.industry, '') AS industry,
    ls.short_pct,
    COALESCE(sc.short_pct_change_4w, 0) AS short_pct_change_4w,
    COALESCE(lp.latest_price, 0) AS latest_price,
    COALESCE(pc.price_change_1m, 0) AS price_change_1m,
    COALESCE(lp.latest_volume, 0) AS latest_volume,
    COALESCE((cm.key_metrics->>'market_cap')::double precision, 0) AS market_cap,
    COALESCE((cm.key_metrics->>'pe_ratio')::double precision, 0) AS pe_ratio,
    COALESCE((cm.key_metrics->>'dividend_yield')::double precision, 0) AS dividend_yield,
    COALESCE(ds.net_director_buy_value, 0) AS net_director_buy_value,
    COALESCE(ds.director_buy_count, 0) AS director_buy_count,
    COALESCE(ds.director_sell_count, 0) AS director_sell_count,
    COALESCE(ns.news_count_30d, 0) AS news_count_30d,
    COALESCE(ns.avg_sentiment, 0) AS avg_sentiment,
    COALESCE(ns.price_sensitive_count, 0) AS price_sensitive_count,
    COALESCE(divs.trailing_12m_dividend, 0) AS trailing_12m_dividend,
    COALESCE(divs.avg_franking_pct, 0) AS avg_franking_pct,
    COALESCE(cm.logo_gcs_url, '') AS logo_url,
    -- New: Days to Cover = short positions / avg daily volume
    COALESCE(av.avg_volume_20d, 0) AS avg_volume_20d,
    CASE
        WHEN COALESCE(av.avg_volume_20d, 0) > 0
        THEN ROUND((ls.reported_short_positions / av.avg_volume_20d)::numeric, 2)
        ELSE 0
    END AS days_to_cover
FROM latest_shorts ls
LEFT JOIN "company-metadata" cm ON cm.stock_code = ls.stock_code
LEFT JOIN short_change sc ON sc.stock_code = ls.stock_code
LEFT JOIN latest_price lp ON lp.stock_code = ls.stock_code
LEFT JOIN avg_volume av ON av.stock_code = ls.stock_code
LEFT JOIN price_change pc ON pc.stock_code = ls.stock_code
LEFT JOIN director_summary ds ON ds.stock_code = ls.stock_code
LEFT JOIN news_summary ns ON ns.stock_code = ls.stock_code
LEFT JOIN dividend_summary divs ON divs.stock_code = ls.stock_code;

-- Unique index for REFRESH CONCURRENTLY
CREATE UNIQUE INDEX idx_mv_screener_data_stock_code ON mv_screener_data (stock_code);

-- Indexes for common filter/sort patterns
CREATE INDEX idx_mv_screener_data_short_pct ON mv_screener_data (short_pct DESC);
CREATE INDEX idx_mv_screener_data_market_cap ON mv_screener_data (market_cap DESC);
CREATE INDEX idx_mv_screener_data_industry ON mv_screener_data (industry);
CREATE INDEX idx_mv_screener_data_days_to_cover ON mv_screener_data (days_to_cover DESC);

-- =====================================================
-- Recreate mv_top_shorts with days_to_cover
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
),
avg_volume AS (
    SELECT
        stock_code,
        AVG(volume)::bigint AS avg_volume_20d
    FROM stock_prices
    WHERE date >= CURRENT_DATE - INTERVAL '35 days'
      AND volume > 0
    GROUP BY stock_code
    HAVING COUNT(*) >= 5
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
    COALESCE(av.avg_volume_20d, 0) AS avg_volume_20d,
    CASE
        WHEN COALESCE(av.avg_volume_20d, 0) > 0
        THEN ROUND((rs."REPORTED_SHORT_POSITIONS" / av.avg_volume_20d)::numeric, 2)
        ELSE 0
    END AS days_to_cover,
    NOW() as last_refreshed
FROM recent_shorts rs
LEFT JOIN "company-metadata" cm ON rs."PRODUCT_CODE" = cm.stock_code
LEFT JOIN avg_volume av ON rs."PRODUCT_CODE" = av.stock_code
ORDER BY rs.current_percent DESC;

CREATE UNIQUE INDEX idx_mv_top_shorts_product ON mv_top_shorts (product_code);
CREATE INDEX idx_mv_top_shorts_percent ON mv_top_shorts (current_percent DESC);
CREATE INDEX idx_mv_top_shorts_industry ON mv_top_shorts (industry, current_percent DESC);
CREATE INDEX idx_mv_top_shorts_days_to_cover ON mv_top_shorts (days_to_cover DESC);

-- =====================================================
-- Update refresh function
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
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_top_shorts concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_top_shorts;
    END;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'Refreshing mv_screener_data...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_screener_data concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_screener_data;
    END;

    RAISE NOTICE 'All materialized views refreshed successfully';
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

ANALYZE mv_screener_data;
ANALYZE mv_top_shorts;
