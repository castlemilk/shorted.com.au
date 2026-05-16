-- Add image_url to news_articles for Apple Stocks-style news cards.
-- Pulled from RSS media:content / media:thumbnail / enclosure or scraped
-- og:image as a fallback. image_pulled_at lets the news-aggregator skip
-- articles that already have an image to keep the backfill cheap.

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_pulled_at TIMESTAMPTZ;

-- Partial index for "articles needing image extraction" — used by the
-- backfill job to find articles without an image_url.
CREATE INDEX IF NOT EXISTS idx_news_articles_missing_image
  ON news_articles (published_at DESC)
  WHERE image_url IS NULL;
