-- Rollback: Drop performance indexes

DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_timeseries_covering;
DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_percent_nonzero;
