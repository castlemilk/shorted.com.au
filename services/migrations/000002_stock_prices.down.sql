-- Drop triggers
DROP TRIGGER IF EXISTS update_stock_prices_updated_at ON stock_prices;

-- Drop function
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop views
DROP VIEW IF EXISTS stock_price_changes;
DROP VIEW IF EXISTS latest_stock_prices;

-- Drop indexes
DROP INDEX IF EXISTS idx_stock_prices_intraday_timestamp;
DROP INDEX IF EXISTS idx_stock_prices_intraday_stock;
DROP INDEX IF EXISTS idx_stock_prices_stock_date;
DROP INDEX IF EXISTS idx_stock_prices_date;
DROP INDEX IF EXISTS idx_stock_prices_stock_code;

-- Drop tables
DROP TABLE IF EXISTS stock_data_ingestion_log;
DROP TABLE IF EXISTS stock_data_quality;
DROP TABLE IF EXISTS stock_prices_intraday;
DROP TABLE IF EXISTS stock_prices;