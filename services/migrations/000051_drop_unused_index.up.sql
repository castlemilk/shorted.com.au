-- 000051_drop_unused_index
--
-- idx_company_metadata_financial_statements (GIN on financial_statements) has 0
-- index scans in pg_stat_user_indexes — no query uses GIN operators (@>, ?, etc.)
-- on that JSONB column, so it only adds write/maintenance overhead. It was
-- created by an old supabase/ migration (not services/migrations), so this
-- DROP IF EXISTS is the canonical removal in the tracked migration history.

DROP INDEX IF EXISTS idx_company_metadata_financial_statements;
