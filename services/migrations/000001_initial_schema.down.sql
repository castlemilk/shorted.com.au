-- Drop indexes
DROP INDEX IF EXISTS idx_subscriptions_status;
DROP INDEX IF EXISTS idx_subscriptions_email;
DROP INDEX IF EXISTS idx_metadata_stock_code;
DROP INDEX IF EXISTS idx_shorts_date;
DROP INDEX IF EXISTS idx_shorts_product_code;
DROP INDEX IF EXISTS idx_shorts_date_percent;
DROP INDEX IF EXISTS idx_shorts_product_code_date;

-- Drop tables
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS "company-metadata";
DROP TABLE IF EXISTS shorts;