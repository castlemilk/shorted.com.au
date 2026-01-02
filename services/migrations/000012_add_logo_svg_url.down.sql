-- Remove SVG logo columns
ALTER TABLE "company-metadata"
DROP COLUMN IF EXISTS logo_svg_gcs_url,
DROP COLUMN IF EXISTS logo_source_url,
DROP COLUMN IF EXISTS logo_format;

