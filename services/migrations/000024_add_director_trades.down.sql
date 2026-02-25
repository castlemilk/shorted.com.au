-- Rollback director trades schema
DROP INDEX IF EXISTS idx_director_trades_type;
DROP INDEX IF EXISTS idx_director_trades_trade_date;
DROP INDEX IF EXISTS idx_director_trades_stock_code_date;
DROP TABLE IF EXISTS director_trades;
