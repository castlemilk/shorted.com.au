DROP VIEW IF EXISTS v_news_clusters;
DROP INDEX IF EXISTS idx_news_articles_cluster;
ALTER TABLE news_articles
  DROP COLUMN IF EXISTS cluster_is_primary,
  DROP COLUMN IF EXISTS cluster_id;
