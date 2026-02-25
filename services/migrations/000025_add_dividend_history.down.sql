-- Rollback dividend history schema
DROP INDEX IF EXISTS idx_dividend_history_ex_date;
DROP INDEX IF EXISTS idx_dividend_history_stock_code_ex_date;
DROP TABLE IF EXISTS dividend_history;
