-- Marketing agency + agents harvested from the same REA/Domain search-results
-- blob the listing itself comes from (REA listingCompany{id,name} + listers[];
-- Domain advertiser/agencyProfile + contactAgents). Additive, nullable — no
-- backfill, populated forward as the crawl re-sweeps.
ALTER TABLE property_listings
  ADD COLUMN IF NOT EXISTS agency_id   TEXT   NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agency_name TEXT   NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agent_names TEXT[] NOT NULL DEFAULT '{}';

-- Lets "listings by this agency/agent" aggregate without a full scan.
CREATE INDEX IF NOT EXISTS idx_property_listings_agency_id
  ON property_listings (agency_id) WHERE agency_id <> '';
