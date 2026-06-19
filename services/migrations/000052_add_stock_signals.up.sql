-- Stock reputation / risk signals, sourced from brandbrain's ResolveBusinessSignals
-- (Gemini-grounded web research with citations). For a short-selling platform these
-- adverse signals (court matters, regulator sanctions, money-laundering findings,
-- safety incidents, complaints) are first-class risk indicators; positive signals
-- (awards, certifications, major press) balance the picture.
--
-- This is the "intelligent crawler" path: instead of bespoke per-source scrapers we
-- call brandbrain (api.brandbrain.dev), which cost-tiers AI discovery and grounds
-- every claim in citations.

CREATE TABLE IF NOT EXISTS stock_signals (
    id           BIGSERIAL PRIMARY KEY,
    stock_code   VARCHAR(20)  NOT NULL,
    polarity     TEXT         NOT NULL,                 -- 'adverse' | 'positive'
    kind         TEXT,                                  -- 'court' | 'sanction' | 'complaint' | 'safety' | 'award' | 'press' | ...
    headline     TEXT         NOT NULL,
    detail       TEXT,
    event_date   TEXT,                                  -- 'YYYY-MM-DD' or 'YYYY' (brandbrain returns either)
    severity     TEXT,                                  -- 'high' | 'medium' | 'low' (adverse only)
    citations    JSONB        NOT NULL DEFAULT '[]',
    confidence   DOUBLE PRECISION,
    source       TEXT         NOT NULL DEFAULT 'brandbrain',
    content_hash TEXT         NOT NULL,                 -- sha1(stock_code|polarity|headline) for idempotent upsert
    fetched_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (stock_code, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_stock_signals_code     ON stock_signals (stock_code, polarity);
CREATE INDEX IF NOT EXISTS idx_stock_signals_severity ON stock_signals (severity) WHERE polarity = 'adverse';

-- Track when each stock was last swept so the collector can skip fresh ones and
-- prioritise stale/never-fetched stocks.
CREATE TABLE IF NOT EXISTS stock_signals_runs (
    stock_code     VARCHAR(20) PRIMARY KEY,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    adverse_count   INTEGER NOT NULL DEFAULT 0,
    positive_count  INTEGER NOT NULL DEFAULT 0
);
