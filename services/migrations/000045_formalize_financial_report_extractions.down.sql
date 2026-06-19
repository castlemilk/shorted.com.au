-- Drop only the columns this migration added. The table itself predates this
-- migration (created at runtime by extract.py), so we do NOT drop it.
ALTER TABLE financial_report_extractions
    DROP COLUMN IF EXISTS raw_text_gcs_url,
    DROP COLUMN IF EXISTS digest_model,
    DROP COLUMN IF EXISTS digest_confidence,
    DROP COLUMN IF EXISTS digest;
