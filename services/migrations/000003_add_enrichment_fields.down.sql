ALTER TABLE "company-metadata"
DROP COLUMN IF EXISTS tags,
DROP COLUMN IF EXISTS enhanced_summary,
DROP COLUMN IF EXISTS company_history,
DROP COLUMN IF EXISTS key_people,
DROP COLUMN IF EXISTS financial_reports,
DROP COLUMN IF EXISTS competitive_advantages,
DROP COLUMN IF EXISTS risk_factors,
DROP COLUMN IF EXISTS recent_developments,
DROP COLUMN IF EXISTS social_media_links,
DROP COLUMN IF EXISTS logo_gcs_url,
DROP COLUMN IF EXISTS enrichment_status,
DROP COLUMN IF EXISTS enrichment_date,
DROP COLUMN IF EXISTS enrichment_error;

