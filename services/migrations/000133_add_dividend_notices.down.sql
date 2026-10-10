DROP TABLE IF EXISTS dividend_notice_attempts;
DROP INDEX IF EXISTS idx_dividend_history_announcement_url;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS announced_on;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS announcement_url;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS declared_amount;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS declared_currency;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS period_end;
ALTER TABLE dividend_history DROP COLUMN IF EXISTS record_date;
