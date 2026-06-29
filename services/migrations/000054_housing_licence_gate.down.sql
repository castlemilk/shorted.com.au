-- Revert mv_housing_headline to the un-gated definition from 000053 (includes
-- all source_licence values). NOTE: rolling this back re-exposes proprietary
-- rows to GetHousingOverview if any exist — only do so deliberately.

DROP MATERIALIZED VIEW IF EXISTS mv_housing_headline;

CREATE MATERIALIZED VIEW mv_housing_headline AS
WITH ranked AS (
    SELECT
        region_code, measure, dwelling_type, period, value, unit, is_preliminary,
        value - LAG(value, 1) OVER w AS qoq_abs,
        (value / NULLIF(LAG(value, 1) OVER w, 0) - 1) * 100 AS qoq_pct,
        value - LAG(value, 4) OVER w AS yoy_abs,
        (value / NULLIF(LAG(value, 4) OVER w, 0) - 1) * 100 AS yoy_pct,
        ROW_NUMBER() OVER (
            PARTITION BY region_code, measure, dwelling_type ORDER BY period DESC
        ) AS rn
    FROM house_prices
    WHERE period_freq = 'Q'
    WINDOW w AS (PARTITION BY region_code, measure, dwelling_type ORDER BY period)
)
SELECT region_code, measure, dwelling_type, period, value, unit, is_preliminary,
       qoq_abs, qoq_pct, yoy_abs, yoy_pct
FROM ranked
WHERE rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_headline_key
    ON mv_housing_headline (region_code, measure, dwelling_type);
