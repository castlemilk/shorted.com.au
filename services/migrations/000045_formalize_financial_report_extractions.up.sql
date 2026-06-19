-- Formalize the financial_report_extractions table, which until now existed in prod
-- ONLY via report-extractor/extract.py's runtime ensure_table(). This mirrors that
-- DDL exactly (idempotent) and adds the compressed-digest + provenance columns.

CREATE TABLE IF NOT EXISTS financial_report_extractions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code      VARCHAR(50) NOT NULL,
    report_url      TEXT NOT NULL UNIQUE,
    report_type     VARCHAR(50),
    report_title    TEXT,
    report_date     DATE,
    metrics         JSONB NOT NULL DEFAULT '{}',
    raw_text_length INTEGER,
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fre_stock_code  ON financial_report_extractions(stock_code);
CREATE INDEX IF NOT EXISTS idx_fre_report_date ON financial_report_extractions(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_fre_report_type ON financial_report_extractions(report_type);

-- Compressed digest (Flash-distilled summary of the report) + provenance.
ALTER TABLE financial_report_extractions
    ADD COLUMN IF NOT EXISTS digest            TEXT,
    ADD COLUMN IF NOT EXISTS digest_confidence DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS digest_model      TEXT,
    ADD COLUMN IF NOT EXISTS raw_text_gcs_url  TEXT;
