-- Stable per-ADDRESS identity for the listing crawl, so price history survives
-- portal listing_id churn on relist AND unifies the same physical address seen
-- on both REA and Domain. address_key is derived from the CANONICAL crawl-target
-- suburb/state/postcode (never the portal's inconsistent display address) — see
-- addressKey() in crawl_address.go. Defaulted to '' (not NULL) so existing rows
-- stay valid without a backfill in this migration; the collector backfills them
-- via `-mode backfill-address` (operator-run, not part of this migration).

ALTER TABLE property_listings
    ADD COLUMN IF NOT EXISTS address_key TEXT NOT NULL DEFAULT '';

ALTER TABLE property_price_events
    ADD COLUMN IF NOT EXISTS address_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_property_listings_address_key
    ON property_listings (address_key) WHERE address_key <> '';

CREATE INDEX IF NOT EXISTS idx_property_price_events_address_key
    ON property_price_events (address_key, observed_at);
