-- Revert 000087: drop the listing-detail table + the base-row detail cursor.
DROP TABLE IF EXISTS property_listing_details;

DROP INDEX IF EXISTS idx_property_listings_detail_todo;

ALTER TABLE property_listings
    DROP COLUMN IF EXISTS detail_fetched_at;
