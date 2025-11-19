-- Migration: Add created_at and updated_at timestamps to company-metadata table
-- These columns are referenced in views but were missing from the original schema

-- Add created_at column if it doesn't exist
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Add updated_at column if it doesn't exist
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create a function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_company_metadata_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at on row updates
DROP TRIGGER IF EXISTS trigger_update_company_metadata_updated_at ON "company-metadata";
CREATE TRIGGER trigger_update_company_metadata_updated_at
    BEFORE UPDATE ON "company-metadata"
    FOR EACH ROW
    EXECUTE FUNCTION update_company_metadata_updated_at();

-- Update existing rows to have timestamps (set to current time if NULL)
UPDATE "company-metadata"
SET created_at = CURRENT_TIMESTAMP
WHERE created_at IS NULL;

UPDATE "company-metadata"
SET updated_at = CURRENT_TIMESTAMP
WHERE updated_at IS NULL;

-- Add comments for documentation
COMMENT ON COLUMN "company-metadata".created_at IS 'Timestamp when the record was first created';
COMMENT ON COLUMN "company-metadata".updated_at IS 'Timestamp when the record was last updated (auto-updated by trigger)';

