-- Recreate the exposure MV with a refresh timestamp. now() is evaluated by
-- CREATE/REFRESH, so every materialized row records the completed snapshot's
-- refresh transaction time. Keep the unique index for CONCURRENTLY refreshes.

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
    rs.current_percent AS short_percent,
    now() AS refreshed_at
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

ANALYZE mv_company_state_exposure;
