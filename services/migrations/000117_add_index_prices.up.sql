-- Migration 000117: benchmark index series (issue #556)
--
-- Absolute returns on the ASX over 2011-2026 are mostly beta. Without a
-- benchmark, every strategy result in the product overstates itself, and so
-- does every result a caller builds on the API — an engine reporting +38% for a
-- 12-month hold is reporting a market return with a strategy sitting on top of
-- it. Alpha is the only number that means anything, and alpha needs a
-- benchmark.
--
-- Kept OUT of stock_prices deliberately. An index is not a security: it has no
-- shares on issue, cannot be shorted, and must never appear in a universe built
-- from the short panel. Putting XJO in stock_prices would have leaked it into
-- GetMarketByDate, the screener and every cross-section — exactly the
-- comparability problem issue #563 is about, self-inflicted.
--
-- REPLAY-SAFE: every statement is IF NOT EXISTS and no MV is dropped, so this
-- is safe in the deploy allowlist, which re-runs it on every deploy.

CREATE TABLE IF NOT EXISTS index_prices (
    index_code   VARCHAR(16)      NOT NULL,
    date         DATE             NOT NULL,
    open         DOUBLE PRECISION,
    high         DOUBLE PRECISION,
    low          DOUBLE PRECISION,
    close        DOUBLE PRECISION,
    -- Index levels are not adjusted the way a share price is; the distinction
    -- that matters is price-return versus total-return, and that is a property
    -- of the SERIES, not of the row. It lives in index_metadata.return_type.
    volume       BIGINT,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT index_prices_code_date_key UNIQUE (index_code, date)
);

CREATE INDEX IF NOT EXISTS idx_index_prices_code_date
    ON index_prices (index_code, date DESC);

-- The registry. Small, hand-curated, and the place a caller learns whether a
-- series reinvests dividends — which decides whether a comparison against it is
-- honest.
CREATE TABLE IF NOT EXISTS index_metadata (
    index_code   VARCHAR(16)  PRIMARY KEY,
    name         TEXT         NOT NULL,
    -- 'price' or 'total'. A price-return benchmark understates the market by
    -- roughly the dividend yield (~4% a year on the ASX), so a strategy
    -- measured against one looks better than it is. Callers must be able to
    -- tell the two apart without knowing what XJT means.
    return_type  VARCHAR(8)   NOT NULL DEFAULT 'price',
    currency     VARCHAR(8)   NOT NULL DEFAULT 'AUD',
    source       TEXT         NOT NULL DEFAULT 'yahoo',
    -- The upstream ticker, kept separate from index_code so our stable public
    -- code does not inherit a vendor's spelling (^AXJO).
    source_symbol TEXT        NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT index_metadata_return_type_check CHECK (return_type IN ('price', 'total'))
);

-- Seeded with ON CONFLICT so a replay is a no-op rather than a duplicate-key
-- failure that would fail the whole deploy.
INSERT INTO index_metadata (index_code, name, return_type, currency, source, source_symbol) VALUES
    ('XJO', 'S&P/ASX 200',                  'price', 'AUD', 'yahoo', '^AXJO'),
    ('XKO', 'S&P/ASX 300',                  'price', 'AUD', 'yahoo', '^AXKO'),
    ('XAO', 'All Ordinaries',               'price', 'AUD', 'yahoo', '^AORD'),
    ('XJT', 'S&P/ASX 200 Gross Total Return','total', 'AUD', 'yahoo', '^AXJT')
ON CONFLICT (index_code) DO UPDATE SET
    name          = EXCLUDED.name,
    return_type   = EXCLUDED.return_type,
    currency      = EXCLUDED.currency,
    source        = EXCLUDED.source,
    source_symbol = EXCLUDED.source_symbol,
    updated_at    = now();
