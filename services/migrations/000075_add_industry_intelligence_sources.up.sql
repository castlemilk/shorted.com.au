-- Industry intelligence source registry and imported signal facts.
--
-- This is the data backbone for the industry-intelligence view. It separates:
--   1. source registry / enablement metadata;
--   2. collection-run observability; and
--   3. imported, cited industry facts.
--
-- Public views should render only imported rows from industry_intelligence_records.
-- The source registry itself is operational metadata and must not be presented as
-- a roadmap promise.

CREATE TABLE IF NOT EXISTS industry_intelligence_sources (
    source_key           TEXT PRIMARY KEY,
    display_name         TEXT NOT NULL,
    signal_kind          TEXT NOT NULL,
    publisher            TEXT NOT NULL,
    source_url           TEXT NOT NULL,
    licence              TEXT NOT NULL DEFAULT '',
    cadence              TEXT NOT NULL DEFAULT '',
    collection_method    TEXT NOT NULL,
    enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    public_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    exact_entity_required BOOLEAN NOT NULL DEFAULT TRUE,
    notes                TEXT NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT industry_intelligence_sources_kind_check
        CHECK (signal_kind IN (
            'short_interest',
            'trade_exposure',
            'public_money',
            'tax_environment',
            'policy_footprint',
            'emissions'
        )),
    CONSTRAINT industry_intelligence_sources_method_check
        CHECK (collection_method IN ('api', 'ckan', 'download', 'html', 'manual'))
);

CREATE TABLE IF NOT EXISTS industry_intelligence_collection_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key       TEXT NOT NULL REFERENCES industry_intelligence_sources(source_key) ON DELETE CASCADE,
    status           TEXT NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    source_as_of     DATE,
    records_seen     INTEGER NOT NULL DEFAULT 0,
    records_imported INTEGER NOT NULL DEFAULT 0,
    records_failed   INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT NOT NULL DEFAULT '',
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT industry_intelligence_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'partial'))
);

CREATE TABLE IF NOT EXISTS industry_intelligence_records (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key       TEXT NOT NULL REFERENCES industry_intelligence_sources(source_key) ON DELETE CASCADE,
    source_record_id TEXT NOT NULL,
    signal_kind      TEXT NOT NULL,
    industry         TEXT NOT NULL,
    stock_code       VARCHAR(50),
    entity_abn       TEXT,
    metric_key       TEXT NOT NULL,
    metric_label     TEXT NOT NULL,
    metric_value     NUMERIC,
    unit             TEXT NOT NULL DEFAULT '',
    period_start     DATE,
    period_end       DATE,
    as_of            DATE NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    summary          TEXT NOT NULL DEFAULT '',
    source_url       TEXT NOT NULL,
    confidence       DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT industry_intelligence_records_kind_check
        CHECK (signal_kind IN (
            'short_interest',
            'trade_exposure',
            'public_money',
            'tax_environment',
            'policy_footprint',
            'emissions'
        )),
    CONSTRAINT industry_intelligence_records_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT industry_intelligence_records_source_record_check
        CHECK (btrim(source_record_id) <> '')
);

CREATE TABLE IF NOT EXISTS industry_intelligence_industry_sources (
    industry       TEXT NOT NULL,
    source_key     TEXT NOT NULL REFERENCES industry_intelligence_sources(source_key) ON DELETE CASCADE,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    public_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_at    TIMESTAMPTZ,
    reviewed_by    TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (industry, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_intelligence_records_source_record
    ON industry_intelligence_records (source_key, source_record_id);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_records_industry_kind_asof
    ON industry_intelligence_records (industry, signal_kind, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_records_source_asof
    ON industry_intelligence_records (source_key, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_records_stock_asof
    ON industry_intelligence_records (stock_code, as_of DESC)
    WHERE stock_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_records_metadata_gin
    ON industry_intelligence_records USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_runs_source_started
    ON industry_intelligence_collection_runs (source_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_runs_status_started
    ON industry_intelligence_collection_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_industry_intelligence_industry_sources_source
    ON industry_intelligence_industry_sources (source_key);

INSERT INTO industry_intelligence_sources
    (source_key, display_name, signal_kind, publisher, source_url, licence, cadence, collection_method, enabled, public_enabled, exact_entity_required, notes)
VALUES
    ('asic-short-interest', 'ASIC short position reports', 'short_interest', 'Australian Securities and Investments Commission', 'https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/', 'ASIC website terms', 'Daily, T+4', 'download', TRUE, TRUE, FALSE, 'Existing live short-interest layer.'),
    ('ato-corporate-tax-transparency', 'ATO Corporate Tax Transparency', 'tax_environment', 'Australian Taxation Office', 'https://data.gov.au/data/dataset/corporate-transparency', 'CC-BY-3.0-AU', 'Annual', 'ckan', TRUE, TRUE, TRUE, 'Imported through the influence collector and exact ASX entity mapping.'),
    ('abs-international-trade-goods', 'International Trade in Goods', 'trade_exposure', 'Australian Bureau of Statistics', 'https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release', 'ABS website terms', 'Monthly', 'download', TRUE, FALSE, TRUE, 'Industry mapping requires reviewed commodity-to-industry mapping before public figures.'),
    ('abs-input-output-tables', 'Australian National Accounts Input-Output Tables', 'trade_exposure', 'Australian Bureau of Statistics', 'https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-input-output-tables/latest-release', 'ABS website terms', 'Annual', 'download', TRUE, FALSE, TRUE, 'Industry exposure backbone for imports, exports, intermediate use, and taxes less subsidies.'),
    ('austender-contract-notices', 'AusTender Contract Notice Export', 'public_money', 'Department of Finance', 'https://data.gov.au/data/dataset/austender-contract-notice-export', 'CC-BY-3.0-AU', 'Daily export', 'ckan', TRUE, FALSE, TRUE, 'Contract notices need exact ABN/entity resolution before public company-level surfacing.'),
    ('grantconnect-awards', 'GrantConnect grants awarded', 'public_money', 'Department of Finance', 'https://www.grants.gov.au/', 'GrantConnect website terms', 'Daily', 'html', TRUE, FALSE, TRUE, 'Grant awards need exact ABN/entity resolution before public company-level surfacing.'),
    ('aec-transparency-register', 'AEC Transparency Register', 'policy_footprint', 'Australian Electoral Commission', 'https://transparency.aec.gov.au/', 'AEC website terms', 'Annual/election returns', 'download', TRUE, FALSE, TRUE, 'Disclosure data needs exact donor/entity resolution and neutral labels.'),
    ('agd-register-lobbyists', 'Australian Government Register of Lobbyists', 'policy_footprint', 'Attorney-General''s Department', 'https://www.ag.gov.au/integrity/australian-government-register-lobbyists', 'AGD website terms', 'Register updates', 'html', TRUE, FALSE, TRUE, 'Register/client records require exact entity matching before public surfacing.'),
    ('agd-fits-register', 'Foreign Influence Transparency Scheme Register', 'policy_footprint', 'Attorney-General''s Department', 'https://www.ag.gov.au/integrity/foreign-influence-transparency-scheme', 'AGD website terms', 'Register updates', 'html', TRUE, FALSE, TRUE, 'Foreign influence records require exact entity matching and review before public surfacing.'),
    ('cer-nger-corporate-emissions', 'NGER corporate emissions and energy data', 'emissions', 'Clean Energy Regulator', 'https://cer.gov.au/markets/reports-and-data/nger-reporting-data-and-registers', 'CER website terms', 'Annual', 'download', TRUE, FALSE, TRUE, 'Corporate emissions records require exact controlling-corporation mapping before public surfacing.')
ON CONFLICT (source_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    signal_kind = EXCLUDED.signal_kind,
    publisher = EXCLUDED.publisher,
    source_url = EXCLUDED.source_url,
    licence = EXCLUDED.licence,
    cadence = EXCLUDED.cadence,
    collection_method = EXCLUDED.collection_method,
    enabled = EXCLUDED.enabled,
    public_enabled = EXCLUDED.public_enabled,
    exact_entity_required = EXCLUDED.exact_entity_required,
    notes = EXCLUDED.notes,
    updated_at = now();
