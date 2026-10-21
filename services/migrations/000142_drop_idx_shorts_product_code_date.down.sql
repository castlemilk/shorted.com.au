-- One statement: CREATE INDEX CONCURRENTLY cannot run in a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shorts_product_code_date
    ON shorts ("PRODUCT_CODE", "DATE" DESC);
