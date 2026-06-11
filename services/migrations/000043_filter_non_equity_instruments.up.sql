-- Migration 000043: Filter non-equity instruments out of UI-facing materialized views
-- Problem: ETFs, bonds/hybrids, and micro-instruments pollute the top-shorts list,
-- treemap, and screener. Observed in prod (June 2026):
--   - ATBHQ "ASIAN DEVELOPMENT 4.35% 17-JAN-29" (a bond, 200k units on issue) ranked
--     #1 most shorted at an impossible 160%
--   - CPPR "ETFS GLB COPPER EW ETF UNITS" (100k units) spiked to 48.67% and became
--     the weekly report headline stock
--   - 175 ETF rows and 40 hybrid/bond rows (5-6 char codes) in mv_top_shorts
--
-- Shared "equities only" filter applied to mv_top_shorts, mv_screener_data and
-- mv_treemap_data:
--   1. PRODUCT does not contain the word ETF        -> exchange traded funds
--   2. PRODUCT_CODE is 3-4 chars                    -> 5-6 char codes are interest
--      rate securities, hybrids, and secondary lines (e.g. ATBHQ, NWSLV)
--   3. PRODUCT has no "N.NN%" coupon pattern        -> bonds/notes named by coupon
--   4. TOTAL_PRODUCT_IN_ISSUE >= 5M (or unknown)    -> micro-instruments whose tiny
--      denominators produce nonsense percentages; every ordinary ASX listing has
--      well over 5M shares on issue
--
-- NOTE: avg_volume_20d = 0 is deliberately NOT used as a filter — stock_prices has
-- coverage gaps for large caps (CTD, MPL, PXA observed with no recent price rows),
-- so zero average volume means "missing price data", not "illiquid".

-- =====================================================
-- Recreate mv_top_shorts with equities-only filter
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
        -- equities-only filter (see header comment)
        AND s."PRODUCT" !~* 'ETF\M'
        AND LENGTH(s."PRODUCT_CODE") <= 4
        AND s."PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
        AND (s."TOTAL_PRODUCT_IN_ISSUE" IS NULL OR s."TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
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
-- Recreate mv_screener_data with equities-only filter
-- (also adds the DEFERRED filter the screener was missing)
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
        AND "PRODUCT" NOT ILIKE '%DEFERRED%'
        -- equities-only filter (see header comment)
        AND "PRODUCT" !~* 'ETF\M'
        AND LENGTH("PRODUCT_CODE") <= 4
        AND "PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
        AND ("TOTAL_PRODUCT_IN_ISSUE" IS NULL OR "TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
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

CREATE UNIQUE INDEX idx_mv_screener_data_stock_code ON mv_screener_data (stock_code);
CREATE INDEX idx_mv_screener_data_short_pct ON mv_screener_data (short_pct DESC);
CREATE INDEX idx_mv_screener_data_market_cap ON mv_screener_data (market_cap DESC);
CREATE INDEX idx_mv_screener_data_industry ON mv_screener_data (industry);
CREATE INDEX idx_mv_screener_data_days_to_cover ON mv_screener_data (days_to_cover DESC);

-- =====================================================
-- Recreate mv_treemap_data with equities-only filter
-- (belt-and-braces: the industry IS NOT NULL join already excludes most ETFs
-- today, but only because ETFs currently lack metadata — enrichment could
-- change that)
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
        AND s."PRODUCT" NOT ILIKE '%DEFERRED%'
        -- equities-only filter (see header comment)
        AND s."PRODUCT" !~* 'ETF\M'
        AND LENGTH(s."PRODUCT_CODE") <= 4
        AND s."PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
        AND (s."TOTAL_PRODUCT_IN_ISSUE" IS NULL OR s."TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
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

CREATE UNIQUE INDEX idx_mv_treemap_unique
ON mv_treemap_data (period_name, product_code);

CREATE INDEX idx_mv_treemap_period_industry
ON mv_treemap_data (period_name, industry, percentage_change DESC NULLS LAST);

CREATE INDEX idx_mv_treemap_period_current
ON mv_treemap_data (period_name, current_short_position DESC);

CREATE INDEX idx_mv_treemap_product
ON mv_treemap_data (product_code, period_name);

ANALYZE mv_top_shorts;
ANALYZE mv_screener_data;
ANALYZE mv_treemap_data;
