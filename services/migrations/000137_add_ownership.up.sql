-- Ownership: who holds ASX stocks.
--
-- Three sources, one map of institutions:
--
-- ownership_institutions     The investors: super funds, index managers, hedge
--                            funds, active managers, banks and brokers,
--                            sovereign and public funds. Curated in Go
--                            (services/jobs/internal/jobs/ownership/registry.go)
--                            and synced by `shorted ownership -mode registry`;
--                            kind is the institution's dominant business, never
--                            inferred from one filing.
-- substantial_holder_notices One row per ASX substantial holding notice (Corporations
--                            Act s671B Forms 603/604/605, and the NZ Financial
--                            Markets Conduct Act disclosure a dual-listed company
--                            files), read from its PDF by `-mode notices`. Every
--                            figure is the notice's own; a notice whose voting
--                            power cannot be read unambiguously has an attempt
--                            and no row. holder_key is the institution's slug
--                            when the holder resolves to one, else
--                            'name:<normalised name>', so an unmapped holder's
--                            notices still group.
-- ownership_funds            The products: every APRA-regulated super fund (APRA's
--                            annual fund-level statistics, with total assets),
--                            and every ASX-quoted ETF, LIC and LIT (ASX's monthly
--                            Investment Products report, with issuer and FUM).
-- fund_holding_snapshots /   Full holdings files: ETF daily holdings and super
-- fund_holdings              fund portfolio holdings disclosures. A row is one
--                            ASX stock in one snapshot; a source row that does
--                            not match an ASX code is counted, never stored.
-- security_identifiers       ISIN and SEDOL to ASX code, read from ETF holdings
--                            files that state both, so a super fund file that
--                            identifies a stock only by ISIN or SEDOL can be
--                            matched.
--
-- v_substantial_holdings_current is each holder's latest notice per stock when
-- that notice leaves it substantial (not a 605, voting power stated).
-- v_fund_holdings_latest is the newest snapshot of every fund.
--
-- Allowlisted in terraform-deploy.yml, so the deploy applies it before the image
-- swap and REPLAYS it on every deploy: IF NOT EXISTS / CREATE OR REPLACE VIEW
-- throughout, no row read or written. The one index on an existing table
-- (asx_announcements, written nightly by the announcements job) is a partial
-- index built only when absent; lock_timeout bounds its first build's wait.
BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS ownership_institutions (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    country     TEXT,
    website     TEXT,
    abn         TEXT,
    -- The institution whose own notices include this one's interests (its
    -- parent, or a 20%+ holder that files for it): a stock's sums count the
    -- group once.
    group_slug  TEXT,
    aliases     TEXT[] NOT NULL DEFAULT '{}',
    aum_aud     NUMERIC(20, 2),
    aum_as_at   DATE,
    aum_source  TEXT,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ownership_institutions_kind_check CHECK (kind IN (
        'super_fund', 'index_manager', 'hedge_fund', 'active_manager',
        'bank_broker', 'sovereign_public', 'insurer', 'private_equity', 'corporate', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_ownership_institutions_kind ON ownership_institutions (kind);

CREATE TABLE IF NOT EXISTS substantial_holder_notices (
    announcement_url TEXT PRIMARY KEY,
    stock_code       VARCHAR(10) NOT NULL,
    form             VARCHAR(3) NOT NULL,
    holder_name      TEXT,
    holder_key       TEXT NOT NULL,
    institution_slug TEXT,
    event_date       DATE,
    announced_on     DATE NOT NULL,
    previous_pct     NUMERIC(7, 4),
    present_pct      NUMERIC(7, 4),
    previous_votes   BIGINT,
    present_votes    BIGINT,
    ceased           BOOLEAN NOT NULL DEFAULT false,
    parser_version   INTEGER NOT NULL,
    parsed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT substantial_holder_notices_form_check CHECK (form IN ('603', '604', '605', 'nz')),
    CONSTRAINT substantial_holder_notices_present_pct_check CHECK (present_pct IS NULL OR (present_pct >= 0 AND present_pct <= 100)),
    CONSTRAINT substantial_holder_notices_previous_pct_check CHECK (previous_pct IS NULL OR (previous_pct >= 0 AND previous_pct <= 100))
);

CREATE INDEX IF NOT EXISTS idx_substantial_notices_stock
    ON substantial_holder_notices (stock_code, holder_key, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_substantial_notices_holder
    ON substantial_holder_notices (holder_key, announced_on DESC);
CREATE INDEX IF NOT EXISTS idx_substantial_notices_announced
    ON substantial_holder_notices (announced_on DESC);

-- Each notice's outcome, so a notice is downloaded once. A notice whose text
-- could not be read is retried after 7 days, at most 3 times; a refusal from
-- an older parser_version is read again.
CREATE TABLE IF NOT EXISTS substantial_holder_notice_attempts (
    announcement_url TEXT PRIMARY KEY,
    stock_code       VARCHAR(10) NOT NULL,
    outcome          VARCHAR(40) NOT NULL,
    detail           TEXT,
    parser_version   INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 1,
    attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The notices pass selects its work from asx_announcements by headline.
CREATE INDEX IF NOT EXISTS idx_asx_ann_substantial
    ON asx_announcements (announcement_date DESC)
    WHERE headline ILIKE '%substantial%';

CREATE TABLE IF NOT EXISTS ownership_funds (
    fund_key         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    fund_type        TEXT NOT NULL,
    asx_code         VARCHAR(10),
    abn              TEXT,
    manager_name     TEXT,
    institution_slug TEXT,
    category         TEXT,
    aum_aud          NUMERIC(20, 2),
    aum_as_at        DATE,
    source           TEXT NOT NULL,
    source_url       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ownership_funds_type_check CHECK (fund_type IN ('super_fund', 'etf', 'lic'))
);

CREATE INDEX IF NOT EXISTS idx_ownership_funds_type ON ownership_funds (fund_type, aum_aud DESC);
CREATE INDEX IF NOT EXISTS idx_ownership_funds_institution ON ownership_funds (institution_slug);

CREATE TABLE IF NOT EXISTS security_identifiers (
    identifier TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    stock_code VARCHAR(10) NOT NULL,
    source     TEXT NOT NULL,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT security_identifiers_kind_check CHECK (kind IN ('isin', 'sedol'))
);

CREATE TABLE IF NOT EXISTS fund_holding_snapshots (
    id               BIGSERIAL PRIMARY KEY,
    institution_slug TEXT NOT NULL,
    fund_name        TEXT NOT NULL,
    fund_code        TEXT,
    source_kind      TEXT NOT NULL,
    source_url       TEXT NOT NULL,
    as_at            DATE NOT NULL,
    holdings_total   INTEGER NOT NULL DEFAULT 0,
    holdings_matched INTEGER NOT NULL DEFAULT 0,
    value_total_aud  NUMERIC(20, 2),
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fund_holding_snapshots_source_kind_check CHECK (source_kind IN ('etf', 'super_phd')),
    CONSTRAINT fund_holding_snapshots_unique UNIQUE (institution_slug, fund_name, as_at)
);

CREATE TABLE IF NOT EXISTS fund_holdings (
    snapshot_id   BIGINT NOT NULL REFERENCES fund_holding_snapshots (id) ON DELETE CASCADE,
    stock_code    VARCHAR(10) NOT NULL,
    security_name TEXT,
    units         NUMERIC(24, 4),
    value_aud     NUMERIC(20, 2),
    weight_pct    NUMERIC(9, 6),
    match_method  TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, stock_code)
);

CREATE INDEX IF NOT EXISTS idx_fund_holdings_stock ON fund_holdings (stock_code);

CREATE OR REPLACE VIEW v_substantial_holdings_current AS
SELECT latest.announcement_url, latest.stock_code, latest.holder_key, latest.institution_slug,
       latest.holder_name, latest.form, latest.event_date, latest.announced_on,
       latest.present_pct, latest.present_votes, latest.previous_pct
FROM (
    SELECT DISTINCT ON (n.stock_code, n.holder_key)
           n.announcement_url, n.stock_code, n.holder_key, n.institution_slug, n.holder_name,
           n.form, n.event_date, n.announced_on, n.present_pct, n.present_votes,
           n.previous_pct, n.ceased
    FROM substantial_holder_notices n
    ORDER BY n.stock_code, n.holder_key, COALESCE(n.event_date, n.announced_on) DESC,
             n.announced_on DESC, n.announcement_url DESC
) latest
WHERE NOT latest.ceased AND latest.present_pct IS NOT NULL;

CREATE OR REPLACE VIEW v_fund_holdings_latest AS
SELECT h.snapshot_id, s.institution_slug, s.fund_name, s.fund_code, s.source_kind, s.as_at,
       h.stock_code, h.security_name, h.units, h.value_aud, h.weight_pct
FROM fund_holdings h
JOIN (
    SELECT DISTINCT ON (institution_slug, fund_name)
           id, institution_slug, fund_name, fund_code, source_kind, as_at
    FROM fund_holding_snapshots
    ORDER BY institution_slug, fund_name, as_at DESC, id DESC
) s ON s.id = h.snapshot_id;

COMMIT;
