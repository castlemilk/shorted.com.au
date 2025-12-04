-- Remove trigger
DROP TRIGGER IF EXISTS trigger_update_search_vector ON "company-metadata";

-- Remove function
DROP FUNCTION IF EXISTS update_company_search_vector();

-- Remove index
DROP INDEX IF EXISTS idx_company_metadata_search_vector;

-- Remove column
ALTER TABLE "company-metadata" DROP COLUMN IF EXISTS search_vector;

