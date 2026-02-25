-- Expand key_people JSONB person objects to include:
-- { name, role, bio, image_url, image_gcs_url, linkedin_url, source_url, source_type }
-- No column changes needed for key_people itself (already JSONB).
-- Add a tracking column for when person-level enrichment was last run.

ALTER TABLE "company-metadata"
  ADD COLUMN IF NOT EXISTS key_people_enriched_at TIMESTAMP WITH TIME ZONE;
