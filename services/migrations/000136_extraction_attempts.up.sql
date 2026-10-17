-- How many times the extractor has read each document. An empty extraction
-- (no metrics and no usable digest, a text layer) is read again while this is at most
-- 2 (services/report-extractor/extract.py EMPTY_RETRY_LIMIT), at least 7 days
-- after the last attempt. Existing rows count as one attempt: the constant
-- DEFAULT fills them without rewriting the table.
--
-- Allowlisted and replayed on every deploy, so the ADD COLUMN runs only when
-- the catalog lacks the column, as in 000132: ALTER TABLE takes its ACCESS
-- EXCLUSIVE lock before IF NOT EXISTS is checked, and the API reads this
-- table. lock_timeout bounds the first apply's wait behind a long reader (a
-- picks filings rebuild): the step fails instead of queueing every read.
BEGIN;

SET LOCAL lock_timeout = '15s';

DO $m136$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema()
                     AND table_name = 'financial_report_extractions'
                     AND column_name = 'extraction_attempts') THEN
        EXECUTE 'ALTER TABLE financial_report_extractions ADD COLUMN IF NOT EXISTS extraction_attempts INTEGER NOT NULL DEFAULT 1';
    END IF;
END
$m136$;

COMMIT;
