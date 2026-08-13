-- Keep quarterly deltas within one source. The fact-table identity includes
-- source; omitting it from LAG interleaves overlapping sources and turns QoQ
-- into a source-vs-source comparison. The final row remains one per public MV
-- key, with source as the deterministic tie-break for equal latest periods.

DROP MATERIALIZED VIEW IF EXISTS mv_housing_headline;

CREATE MATERIALIZED VIEW mv_housing_headline AS
WITH deltas AS (
    SELECT
        region_code, measure, dwelling_type, period, value, unit, is_preliminary, source,
        value - LAG(value, 1) OVER w AS qoq_abs,
        (value / NULLIF(LAG(value, 1) OVER w, 0) - 1) * 100 AS qoq_pct,
        value - LAG(value, 4) OVER w AS yoy_abs,
        (value / NULLIF(LAG(value, 4) OVER w, 0) - 1) * 100 AS yoy_pct
    FROM house_prices
    WHERE period_freq = 'Q'
      AND source_licence <> 'proprietary-tos-restricted'
    WINDOW w AS (PARTITION BY region_code, measure, dwelling_type, source ORDER BY period)
), ranked AS (
    SELECT deltas.*,
           ROW_NUMBER() OVER (
               PARTITION BY region_code, measure, dwelling_type
               ORDER BY period DESC, source
           ) AS rn
    FROM deltas
)
SELECT region_code, measure, dwelling_type, period, value, unit, is_preliminary,
       qoq_abs, qoq_pct, yoy_abs, yoy_pct
FROM ranked
WHERE rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_headline_key
    ON mv_housing_headline (region_code, measure, dwelling_type);
