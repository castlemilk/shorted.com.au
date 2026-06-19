CREATE TABLE IF NOT EXISTS entities (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    stock_code      TEXT,
    attrs           JSONB NOT NULL DEFAULT '{}',
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_entities_stock_code ON entities(stock_code) WHERE stock_code IS NOT NULL;
