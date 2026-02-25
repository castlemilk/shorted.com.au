-- Migration 000022: Add Performance Indexes
-- Purpose: Covering index for time series queries, partial index for non-zero short positions
-- These avoid heap lookups and skip zero-percent rows respectively.

-- Covering index: avoids heap lookups for time series queries
-- The INCLUDE column is returned without visiting the table heap
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shorts_timeseries_covering
ON shorts("PRODUCT_CODE", "DATE" DESC)
INCLUDE ("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");

-- Partial index: skip zero-percent rows in queries that filter on > 0
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shorts_percent_nonzero
ON shorts("PRODUCT_CODE", "DATE" DESC)
WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0;
