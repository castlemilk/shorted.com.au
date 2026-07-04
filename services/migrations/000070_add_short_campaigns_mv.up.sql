-- 000070_add_short_campaigns_mv
--
-- Short-seller scoreboard: one row per stock that had a meaningful short
-- campaign (peak short interest >= 5%) over the last 3 years, with what the
-- price did 3 and 6 months after the peak. Nobody computes ASX short-campaign
-- outcomes — this powers the /battlegrounds "Scoreboard" tab and the
-- GetShortCampaignScoreboard RPC.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_short_campaigns AS
WITH ranked AS (
    SELECT
        "PRODUCT_CODE" AS stock_code,
        "DATE"::date AS peak_date,
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS peak_short_pct,
        ROW_NUMBER() OVER (
            PARTITION BY "PRODUCT_CODE"
            ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC,
                     "DATE" DESC
        ) AS rn
    FROM shorts
    WHERE "DATE" >= NOW() - INTERVAL '3 years'
      AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
),
peaks AS (
    SELECT stock_code, peak_date, peak_short_pct
    FROM ranked
    WHERE rn = 1
      AND peak_short_pct >= 5.0
)
SELECT
    p.stock_code,
    p.peak_date,
    p.peak_short_pct,
    pk.close AS price_at_peak,
    p3.close AS price_3m_after,
    p6.close AS price_6m_after,
    ROUND(((p3.close - pk.close) / NULLIF(pk.close, 0) * 100)::numeric, 2)::double precision AS return_3m,
    ROUND(((p6.close - pk.close) / NULLIF(pk.close, 0) * 100)::numeric, 2)::double precision AS return_6m,
    CASE
        WHEN p3.close IS NULL OR pk.close IS NULL OR pk.close = 0 THEN NULL
        ELSE p3.close < pk.close
    END AS shorts_won_3m,
    CASE
        WHEN p6.close IS NULL OR pk.close IS NULL OR pk.close = 0 THEN NULL
        ELSE p6.close < pk.close
    END AS shorts_won_6m,
    cur.current_short_pct,
    lp.close AS latest_price,
    COALESCE(cm.company_name, '') AS company_name,
    COALESCE(cm.industry, '') AS industry,
    COALESCE(cm.logo_gcs_url, '') AS logo_url
FROM peaks p
LEFT JOIN LATERAL (
    SELECT sp.close
    FROM stock_prices sp
    WHERE sp.stock_code = p.stock_code AND sp.date <= p.peak_date
    ORDER BY sp.date DESC
    LIMIT 1
) pk ON TRUE
LEFT JOIN LATERAL (
    SELECT sp.close
    FROM stock_prices sp
    WHERE sp.stock_code = p.stock_code
      AND sp.date >= p.peak_date + INTERVAL '3 months'
    ORDER BY sp.date ASC
    LIMIT 1
) p3 ON TRUE
LEFT JOIN LATERAL (
    SELECT sp.close
    FROM stock_prices sp
    WHERE sp.stock_code = p.stock_code
      AND sp.date >= p.peak_date + INTERVAL '6 months'
    ORDER BY sp.date ASC
    LIMIT 1
) p6 ON TRUE
LEFT JOIN LATERAL (
    SELECT s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_short_pct
    FROM shorts s
    WHERE s."PRODUCT_CODE" = p.stock_code
    ORDER BY s."DATE" DESC
    LIMIT 1
) cur ON TRUE
LEFT JOIN LATERAL (
    SELECT sp.close
    FROM stock_prices sp
    WHERE sp.stock_code = p.stock_code
    ORDER BY sp.date DESC
    LIMIT 1
) lp ON TRUE
LEFT JOIN "company-metadata" cm ON cm.stock_code = p.stock_code;

-- Unique index: enables REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_short_campaigns_stock_code
    ON mv_short_campaigns (stock_code);

-- Common sort/filter patterns
CREATE INDEX IF NOT EXISTS idx_mv_short_campaigns_peak_pct
    ON mv_short_campaigns (peak_short_pct DESC);
CREATE INDEX IF NOT EXISTS idx_mv_short_campaigns_industry
    ON mv_short_campaigns (industry);

-- Extend the standard refresh routine. Preserves the five existing MVs from
-- migration 000049 and adds mv_short_campaigns with the concurrent-then-fallback
-- pattern (same posture migration 000027 used for mv_screener_data).
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_top_shorts (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_treemap_data...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'Refreshing mv_screener_data (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;

    RAISE NOTICE 'Refreshing mv_available_dates (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_available_dates;

    RAISE NOTICE 'Refreshing mv_short_campaigns...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_short_campaigns;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_short_campaigns concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_short_campaigns;
    END;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$ LANGUAGE plpgsql;

-- Populate once so the first deploy serves data without waiting for a sync.
-- (Plain, non-concurrent refresh: CONCURRENTLY cannot run inside the
-- golang-migrate transaction.)
REFRESH MATERIALIZED VIEW mv_short_campaigns;

ANALYZE mv_short_campaigns;
