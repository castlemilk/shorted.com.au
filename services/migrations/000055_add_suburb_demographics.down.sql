DROP INDEX IF EXISTS idx_house_price_regions_sal;
ALTER TABLE house_price_regions DROP COLUMN IF EXISTS sal_code;
DROP TABLE IF EXISTS suburb_demographics;
