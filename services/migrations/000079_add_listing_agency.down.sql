DROP INDEX IF EXISTS idx_property_listings_agency_id;
ALTER TABLE property_listings
  DROP COLUMN IF EXISTS agency_id,
  DROP COLUMN IF EXISTS agency_name,
  DROP COLUMN IF EXISTS agent_names;
