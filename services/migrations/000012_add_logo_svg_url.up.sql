-- Add columns for SVG logo storage and tracking
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS logo_svg_gcs_url TEXT,
ADD COLUMN IF NOT EXISTS logo_source_url TEXT,
ADD COLUMN IF NOT EXISTS logo_format VARCHAR(10);

-- Add comment for documentation
COMMENT ON COLUMN "company-metadata".logo_svg_gcs_url IS 'GCS URL for SVG logo if available';
COMMENT ON COLUMN "company-metadata".logo_source_url IS 'Original URL where the logo was found';
COMMENT ON COLUMN "company-metadata".logo_format IS 'Format of the best logo found (svg, png, jpeg, etc)';

