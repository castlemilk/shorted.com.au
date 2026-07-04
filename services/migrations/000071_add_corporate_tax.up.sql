-- Track A Phase 1 — Tax × Shorts.
--
-- Two tables underpin the corporate-tax influence layer:
--
--   corporate_tax   — the ATO Corporate Tax Transparency fact table. One row per
--                     (ABN, income_year). Only the three legislated fields exist
--                     (total income, taxable income, tax payable); taxable_income
--                     and tax_payable are NULLABLE and their NULL/blank state is
--                     MEANINGFUL (not reported / nil), so never coalesce to 0 on
--                     ingest. Editorial standards (docs/influence-editorial-standards.md)
--                     require total + taxable income to always render beside tax
--                     payable, and nil tax to carry the ATO "often legitimate" caveat.
--
--   entity_asx_map  — the ABN → ASX-code spine. Only exact-ABN or exact-normalised
--                     name matches surface publicly (match_method). confidence lets a
--                     later fuzzy pass coexist as analyst-only (never public) data.
--
-- source_licence follows the house_prices pattern. ATO data is CC BY 3.0 AU
-- (republishable with attribution).
CREATE TABLE IF NOT EXISTS corporate_tax (
    abn            TEXT    NOT NULL,
    entity_name    TEXT,
    income_year    INT     NOT NULL,
    total_income   NUMERIC,
    taxable_income NUMERIC,
    tax_payable    NUMERIC,
    source         TEXT        NOT NULL DEFAULT 'ato-corporate-tax-transparency',
    source_licence TEXT        NOT NULL DEFAULT 'CC-BY-3.0-AU',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (abn, income_year)
);

CREATE TABLE IF NOT EXISTS entity_asx_map (
    abn          TEXT             PRIMARY KEY,
    stock_code   VARCHAR(50)      NOT NULL,
    entity_name  TEXT,
    match_method TEXT,
    confidence   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_asx_map_stock_code
    ON entity_asx_map (stock_code);
