-- Partial index supporting the deduplicated feed query:
-- WHERE (cluster_id IS NULL OR cluster_is_primary = TRUE) ORDER BY published_at DESC LIMIT n
CREATE INDEX IF NOT EXISTS idx_news_articles_feed
  ON news_articles (published_at DESC)
  WHERE cluster_id IS NULL OR cluster_is_primary = TRUE;
