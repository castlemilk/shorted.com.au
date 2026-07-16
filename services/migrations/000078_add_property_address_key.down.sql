DROP INDEX IF EXISTS idx_property_price_events_address_key;
DROP INDEX IF EXISTS idx_property_listings_address_key;

ALTER TABLE property_price_events DROP COLUMN IF EXISTS address_key;
ALTER TABLE property_listings DROP COLUMN IF EXISTS address_key;
