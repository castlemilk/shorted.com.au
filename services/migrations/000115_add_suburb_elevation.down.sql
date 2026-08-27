ALTER TABLE suburb_demographics
  DROP CONSTRAINT IF EXISTS suburb_demographics_land_share_bounds_check,
  DROP CONSTRAINT IF EXISTS suburb_demographics_elevation_order_check;

ALTER TABLE suburb_demographics
  DROP COLUMN IF EXISTS elevation_min_m,
  DROP COLUMN IF EXISTS elevation_median_m,
  DROP COLUMN IF EXISTS elevation_max_m,
  DROP COLUMN IF EXISTS land_share_below_1m,
  DROP COLUMN IF EXISTS land_share_below_2m,
  DROP COLUMN IF EXISTS land_share_below_5m;
