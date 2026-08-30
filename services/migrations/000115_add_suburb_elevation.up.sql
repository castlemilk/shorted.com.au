ALTER TABLE suburb_demographics
  ADD COLUMN IF NOT EXISTS elevation_min_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS elevation_median_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS elevation_max_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS land_share_below_1m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS land_share_below_2m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS land_share_below_5m DOUBLE PRECISION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'suburb_demographics_land_share_bounds_check'
      AND conrelid = 'suburb_demographics'::regclass
  ) THEN
    ALTER TABLE suburb_demographics
      ADD CONSTRAINT suburb_demographics_land_share_bounds_check CHECK (
        (land_share_below_1m IS NULL OR land_share_below_1m BETWEEN 0 AND 100)
        AND (land_share_below_2m IS NULL OR land_share_below_2m BETWEEN 0 AND 100)
        AND (land_share_below_5m IS NULL OR land_share_below_5m BETWEEN 0 AND 100)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'suburb_demographics_elevation_order_check'
      AND conrelid = 'suburb_demographics'::regclass
  ) THEN
    ALTER TABLE suburb_demographics
      ADD CONSTRAINT suburb_demographics_elevation_order_check CHECK (
        elevation_min_m IS NULL
        OR elevation_median_m IS NULL
        OR elevation_max_m IS NULL
        OR (
          elevation_min_m <= elevation_median_m
          AND elevation_median_m <= elevation_max_m
        )
      );
  END IF;
END
$$;
