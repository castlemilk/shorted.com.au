DROP INDEX IF EXISTS idx_economic_series_public;
ALTER TABLE economic_series DROP COLUMN IF EXISTS internal_only;
