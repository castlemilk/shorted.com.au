-- Company operations-weighted state exposure: LLM-estimated geographic
-- breakdown of a company's operating footprint, plus a cheap hq_state
-- fallback derived from the registered-office address. Feeds the /economy
-- state map + dossier "Operating here" section.

ALTER TABLE "company-metadata"
    ADD COLUMN IF NOT EXISTS state_exposure JSONB DEFAULT '[]'::jsonb;

ALTER TABLE "company-metadata"
    ADD COLUMN IF NOT EXISTS hq_state TEXT;

-- Backfill hq_state from the free-text address, e.g.
-- "179 Normanby Road, SOUTH MELBOURNE, VIC, AUSTRALIA, 3205" -> 'vic'.
UPDATE "company-metadata"
SET hq_state = lower((regexp_match(upper(address), ',\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*,\s*AUSTRALIA'))[1])
WHERE address IS NOT NULL AND hq_state IS NULL;

-- One row per (stock_code, region): LLM-sourced exposure rows plus a
-- registered-office fallback row (weight 1.0) for companies the LLM
-- backfill hasn't reached yet. 'international' rows are included so the
-- dossier can show AU-exposure honestly; map aggregates filter it out.
DROP MATERIALIZED VIEW IF EXISTS mv_company_state_exposure;

CREATE MATERIALIZED VIEW mv_company_state_exposure AS
WITH latest_date AS (
    SELECT max(shorts."DATE") AS max_date
    FROM shorts
), recent_shorts AS (
    SELECT DISTINCT ON (s."PRODUCT_CODE") s."PRODUCT_CODE",
        s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_percent
    FROM (shorts s CROSS JOIN latest_date ld)
    WHERE s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
        AND s."DATE" > (ld.max_date - '1 mon'::interval)
        AND s."PRODUCT" !~~* '%DEFERRED SETTLEMENT%'
        AND s."PRODUCT" !~~* '%DEFERRED%'
    ORDER BY s."PRODUCT_CODE", s."DATE" DESC
), llm_rows AS (
    SELECT
        cm.stock_code,
        lower(exposure.value ->> 'region') AS region,
        (exposure.value ->> 'weight')::numeric AS weight,
        exposure.value ->> 'basis' AS basis,
        'llm'::text AS source
    FROM "company-metadata" cm
    CROSS JOIN LATERAL jsonb_array_elements(cm.state_exposure) AS exposure(value)
    WHERE cm.state_exposure IS NOT NULL AND cm.state_exposure <> '[]'::jsonb
), fallback_rows AS (
    SELECT
        cm.stock_code,
        cm.hq_state AS region,
        1.0::numeric AS weight,
        'Registered office'::text AS basis,
        'hq_fallback'::text AS source
    FROM "company-metadata" cm
    WHERE cm.hq_state IS NOT NULL
        AND (cm.state_exposure IS NULL OR cm.state_exposure = '[]'::jsonb)
), combined AS (
    SELECT * FROM llm_rows
    UNION ALL
    SELECT * FROM fallback_rows
)
SELECT
    c.stock_code,
    c.region,
    c.weight,
    c.basis,
    c.source,
    cm.company_name,
    cm.industry,
    CASE WHEN cm.market_cap ~ '^[0-9.]+$' THEN cm.market_cap::numeric ELSE NULL END AS market_cap,
    cm.logo_icon_gcs_url,
    rs.current_percent AS short_percent
FROM combined c
JOIN "company-metadata" cm ON cm.stock_code = c.stock_code
LEFT JOIN recent_shorts rs ON rs."PRODUCT_CODE" = c.stock_code
WHERE c.region IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_company_state_exposure_stock_region
    ON mv_company_state_exposure (stock_code, region);

CREATE INDEX IF NOT EXISTS idx_mv_company_state_exposure_region_weight
    ON mv_company_state_exposure (region, weight DESC);

COMMENT ON MATERIALIZED VIEW mv_company_state_exposure IS
    'Operations-weighted state exposure per company: LLM-estimated rows (source=llm) plus a registered-office fallback row (source=hq_fallback) for companies not yet enriched. Includes region=international rows; map aggregates should exclude those.';

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
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

    RAISE NOTICE 'Refreshing mv_stock_price_coverage...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage;

    RAISE NOTICE 'Refreshing mv_company_state_exposure (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_company_state_exposure;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$;

ANALYZE mv_company_state_exposure;
