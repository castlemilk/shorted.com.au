DROP INDEX IF EXISTS idx_news_articles_missing_image;
ALTER TABLE news_articles
  DROP COLUMN IF EXISTS image_pulled_at,
  DROP COLUMN IF EXISTS image_url;
