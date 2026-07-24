-- Precomputed rolling correlations between a markets anchor and eligible
-- economic overlays. The generated magnitude keeps ranking portable and
-- indexable without relying on an expression-index spelling in consumers.

CREATE TABLE economic_correlations (
    base_series_key    TEXT NOT NULL,
    overlay_series_key TEXT NOT NULL,
    window_months      INT NOT NULL,
    r                  DOUBLE PRECISION NOT NULL,
    n                  INT NOT NULL,
    last_period        DATE NOT NULL,
    computed_at        TIMESTAMPTZ NOT NULL,
    abs_r              DOUBLE PRECISION GENERATED ALWAYS AS (abs(r)) STORED,
    PRIMARY KEY (base_series_key, overlay_series_key, window_months)
);

CREATE INDEX idx_economic_correlations_base_window_abs_r
    ON economic_correlations (base_series_key, window_months, abs_r DESC);
