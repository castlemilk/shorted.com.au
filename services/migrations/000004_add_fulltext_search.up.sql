-- Add full-text search vector column
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_company_metadata_search_vector 
ON "company-metadata" USING GIN (search_vector);

-- Create function to update search vector
-- Uses columns from initial schema (description) and enrichment (enhanced_summary, etc.)
CREATE OR REPLACE FUNCTION update_company_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        COALESCE(NEW.stock_code, '') || ' ' ||
        COALESCE(NEW.company_name, '') || ' ' ||
        COALESCE(NEW.industry, '') || ' ' ||
        COALESCE(NEW.sector, '') || ' ' ||
        COALESCE(NEW.description, '') || ' ' ||
        COALESCE(NEW.enhanced_summary, '') || ' ' ||
        COALESCE(NEW.company_history, '') || ' ' ||
        COALESCE(NEW.competitive_advantages, '') || ' ' ||
        COALESCE(NEW.risk_factors, '') || ' ' ||
        COALESCE(NEW.recent_developments, '') || ' ' ||
        COALESCE(array_to_string(NEW.tags, ' '), '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update on insert/update
DROP TRIGGER IF EXISTS trigger_update_search_vector ON "company-metadata";
CREATE TRIGGER trigger_update_search_vector
    BEFORE INSERT OR UPDATE ON "company-metadata"
    FOR EACH ROW
    EXECUTE FUNCTION update_company_search_vector();

-- Backfill existing records
UPDATE "company-metadata"
SET search_vector = to_tsvector('english',
    COALESCE(stock_code, '') || ' ' ||
    COALESCE(company_name, '') || ' ' ||
    COALESCE(industry, '') || ' ' ||
    COALESCE(sector, '') || ' ' ||
    COALESCE(description, '') || ' ' ||
    COALESCE(enhanced_summary, '') || ' ' ||
    COALESCE(company_history, '') || ' ' ||
    COALESCE(competitive_advantages, '') || ' ' ||
    COALESCE(risk_factors, '') || ' ' ||
    COALESCE(recent_developments, '') || ' ' ||
    COALESCE(array_to_string(tags, ' '), '')
);

