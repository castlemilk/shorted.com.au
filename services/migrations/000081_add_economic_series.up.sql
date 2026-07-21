-- 000081_add_economic_series.up.sql
-- Generic economic series layer (SDMX-shaped): catalog + observations.
-- Fed by services/economy-collector; read by ListEconomicSeries/GetEconomicSeries.

CREATE TABLE IF NOT EXISTS economic_series (
    id           BIGSERIAL PRIMARY KEY,
    series_key   TEXT UNIQUE NOT NULL,
    topic        TEXT NOT NULL,
    metric       TEXT NOT NULL,
    product      TEXT,
    region_type  TEXT NOT NULL,
    region_code  TEXT NOT NULL,
    region_name  TEXT NOT NULL,
    unit         TEXT NOT NULL,
    frequency    TEXT NOT NULL,
    adjustment   TEXT NOT NULL DEFAULT 'original',
    dimensions   JSONB NOT NULL DEFAULT '{}',
    source_key   TEXT NOT NULL,
    licence      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_economic_series_topic_metric
    ON economic_series (topic, metric);
CREATE INDEX IF NOT EXISTS idx_economic_series_source
    ON economic_series (source_key);

CREATE TABLE IF NOT EXISTS economic_observations (
    series_id  BIGINT NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
    period     DATE NOT NULL,
    value      DOUBLE PRECISION NOT NULL,
    UNIQUE (series_id, period)
);

CREATE INDEX IF NOT EXISTS idx_economic_obs_series_period
    ON economic_observations (series_id, period DESC);
