-- Add key_metrics column to company-metadata table
-- This column stores real-time financial metrics from Yahoo Finance

-- Add key_metrics JSONB column
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS key_metrics JSONB;

-- Add timestamp for when key metrics were last updated
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS key_metrics_updated_at TIMESTAMP WITH TIME ZONE;

-- Create index for querying by market cap (common filter)
CREATE INDEX IF NOT EXISTS idx_company_metadata_market_cap 
ON "company-metadata" ((key_metrics->>'market_cap'));

-- Create index for P/E ratio queries
CREATE INDEX IF NOT EXISTS idx_company_metadata_pe_ratio 
ON "company-metadata" ((key_metrics->>'pe_ratio'));

-- Comment on new columns
COMMENT ON COLUMN "company-metadata".key_metrics IS 'Real-time financial metrics from Yahoo Finance (P/E, market cap, EPS, etc.)';
COMMENT ON COLUMN "company-metadata".key_metrics_updated_at IS 'Timestamp when key_metrics was last updated by daily sync';

