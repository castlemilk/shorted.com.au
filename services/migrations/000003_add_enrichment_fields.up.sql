ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS tags TEXT[],
ADD COLUMN IF NOT EXISTS enhanced_summary TEXT,
ADD COLUMN IF NOT EXISTS company_history TEXT,
ADD COLUMN IF NOT EXISTS key_people JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS financial_reports JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS competitive_advantages TEXT,
ADD COLUMN IF NOT EXISTS risk_factors TEXT,
ADD COLUMN IF NOT EXISTS recent_developments TEXT,
ADD COLUMN IF NOT EXISTS social_media_links JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS logo_gcs_url TEXT,
ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(50) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS enrichment_date TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS enrichment_error TEXT;

CREATE INDEX IF NOT EXISTS idx_company_metadata_tags ON "company-metadata" USING GIN (tags);

