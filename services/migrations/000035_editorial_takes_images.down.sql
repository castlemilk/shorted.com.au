ALTER TABLE editorial_takes
  DROP COLUMN IF EXISTS inline_images,
  DROP COLUMN IF EXISTS hero_image_url;
