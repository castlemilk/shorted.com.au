-- 000051_drop_unused_index (down)
-- Recreate the GIN index (it was unused; restored only for symmetry).

CREATE INDEX IF NOT EXISTS idx_company_metadata_financial_statements
    ON "company-metadata" USING GIN (financial_statements);
