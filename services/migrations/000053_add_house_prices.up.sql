-- House-price tracking: a multi-source (ABS / RBA / state-government / crawl)
-- fact store. Narrow EAV shape (one row per region × measure × dwelling × period
-- × source) so heterogeneous sources at different granularities share one table.
-- Mirrors the project's idempotent-upsert + *_runs cursor conventions.

-- Location dimension. region_type lets one table hold national/state/gccsa/suburb.
CREATE TABLE IF NOT EXISTS house_price_regions (
    region_code TEXT PRIMARY KEY,        -- 'AUS', '1' (state), '1GSYD', 'SUBURB:RICHMOND-3121'
    region_type TEXT NOT NULL,           -- 'national' | 'state' | 'gccsa' | 'suburb' | 'lga'
    region_name TEXT NOT NULL,
    state_code  TEXT,                    -- 'NSW' etc; NULL for national
    postcode    TEXT
);

-- Fact table: one observation per region × measure × dwelling_type × period × source.
CREATE TABLE IF NOT EXISTS house_prices (
    id             BIGSERIAL PRIMARY KEY,
    region_code    TEXT NOT NULL REFERENCES house_price_regions(region_code),
    measure        TEXT NOT NULL,        -- 'mean_price' | 'median_price' | 'total_value'
                                         -- | 'price_index' | 'transfer_count' | 'median_rent'
                                         -- | 'debt_to_income' | 'price_to_income'
    dwelling_type  TEXT NOT NULL DEFAULT 'all',  -- 'established_house' | 'attached' | 'all'
    period         DATE NOT NULL,        -- period-end date (YYYY-Qn -> last day of qtr)
    period_freq    TEXT NOT NULL DEFAULT 'Q',    -- 'Q' | 'M' | 'A'
    value          DOUBLE PRECISION NOT NULL,
    unit           TEXT,                 -- 'AUD' | 'index' | 'ratio' | 'count'
    is_preliminary BOOLEAN NOT NULL DEFAULT false,  -- ABS latest qtr is CoreLogic-proxied
    source         TEXT NOT NULL,        -- 'abs_res_dwell_st' | 'abs_res_dwell' | 'abs_rppi'
                                         -- | 'rba' | 'vic_vpsr' | 'sa_metro' | 'nsw_psi'
                                         -- | 'domain_api' | 'crawl_rea' | 'crawl_domain'
    source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0',  -- carried for republish gating
    content_hash   TEXT NOT NULL,        -- sha1(region|measure|dwelling|period|source) idempotency
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (region_code, measure, dwelling_type, period, source)
);

CREATE INDEX IF NOT EXISTS idx_house_prices_series
    ON house_prices (region_code, measure, dwelling_type, period DESC);
CREATE INDEX IF NOT EXISTS idx_house_prices_measure_period
    ON house_prices (measure, period DESC);
CREATE INDEX IF NOT EXISTS idx_house_prices_source ON house_prices (source);

-- Per-source ingest cursor (mirrors stock_signals_runs).
CREATE TABLE IF NOT EXISTS house_price_ingest_runs (
    source          TEXT PRIMARY KEY,
    last_period     DATE,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rows_upserted   INTEGER NOT NULL DEFAULT 0,
    status          TEXT,                -- 'ok' | 'error'
    detail          TEXT
);

-- Headline MV: latest observation + QoQ/YoY deltas per region × measure × dwelling
-- (quarterly series only). Drives the /housing dashboard tiles cheaply.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_housing_headline AS
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

-- Unique index enables REFRESH ... CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_headline_key
    ON mv_housing_headline (region_code, measure, dwelling_type);

-- Dedicated refresh: housing updates quarterly, decoupled from the daily shorts
-- refresh_all_materialized_views() routine. The collector calls this post-ingest.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
END;
$$ LANGUAGE plpgsql;
