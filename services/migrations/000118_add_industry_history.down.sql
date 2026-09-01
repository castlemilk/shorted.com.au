DROP TRIGGER IF EXISTS trg_record_industry_change ON "company-metadata";
DROP FUNCTION IF EXISTS record_industry_change();
DROP INDEX IF EXISTS idx_stock_industry_history_unique;
DROP INDEX IF EXISTS idx_stock_industry_history_code_from;
DROP TABLE IF EXISTS stock_industry_history;
