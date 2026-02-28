-- Add index for efficient cleanup of old news articles
CREATE INDEX IF NOT EXISTS idx_news_articles_created_at ON news_articles (created_at);

-- Function to clean up news articles older than 90 days
CREATE OR REPLACE FUNCTION cleanup_old_news_articles()
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM news_articles
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
