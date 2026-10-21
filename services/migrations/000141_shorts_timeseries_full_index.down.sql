-- One statement: DROP INDEX CONCURRENTLY cannot run in a transaction block.
-- Apply 000143 and 000142 down first if they were applied, so the chart keeps
-- an index on (PRODUCT_CODE, DATE DESC).
DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_timeseries_full;
