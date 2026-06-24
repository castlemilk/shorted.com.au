-- Safety gate: keep internal, ToS-restricted REA/Domain/brandbrain rows
-- (source_licence = 'proprietary-tos-restricted') out of the public housing
-- read surface. The base-table read paths (GetHousePriceSeries,
-- ListHousingRegions) gate in their query bodies, but mv_housing_headline —
-- which drives GetHousingOverview — does not carry source_licence, so the
-- exclusion must be baked into the MV definition itself.
--
-- This migration redefines mv_housing_headline to exclude proprietary rows
-- before ranking. Apply separately from the code change (the MV is already
-- deployed). On prod Supabase, run via the SESSION pooler (port 5432) with
-- PGOPTIONS="-c statement_timeout=0" so the CONCURRENTLY refresh can complete.

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
      AND source_licence <> 'proprietary-tos-restricted'  -- public surface only
    WINDOW w AS (PARTITION BY region_code, measure, dwelling_type ORDER BY period)
)
SELECT region_code, measure, dwelling_type, period, value, unit, is_preliminary,
       qoq_abs, qoq_pct, yoy_abs, yoy_pct
FROM ranked
WHERE rn = 1;

-- Unique index enables REFRESH ... CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_headline_key
    ON mv_housing_headline (region_code, measure, dwelling_type);
