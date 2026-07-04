-- Rollback: Drop performance indexes

DROP INDEX IF EXISTS idx_shorts_timeseries_covering;
DROP INDEX IF EXISTS idx_shorts_percent_nonzero;
