-- Story clustering: group multiple articles covering the same event
-- (often the same announcement reported by Stockhead, Motley Fool,
-- Google News, etc.) into a single "cluster" so the /news UI can
-- render one card per story with a source-count badge.
--
-- A cluster_id is assigned by the news-aggregator's clustering job,
-- which fingerprints headlines (stock_code + n-gram + 12h window) and
-- merges matches.

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS cluster_id UUID,
  ADD COLUMN IF NOT EXISTS cluster_is_primary BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_news_articles_cluster
  ON news_articles (cluster_id, published_at DESC)
  WHERE cluster_id IS NOT NULL;

-- Helper view that surfaces one row per cluster with the primary
-- article's fields + a source count. Used by GetMarketNews and
-- GetStockNews when grouped mode is enabled.
CREATE OR REPLACE VIEW v_news_clusters AS
SELECT
  c.cluster_id,
  p.id AS primary_id,
  p.stock_code,
  p.source AS primary_source,
  p.headline,
  p.url,
  p.published_at,
  p.sentiment,
  p.relevance_score,
  p.is_price_sensitive,
  p.summary,
  p.image_url,
  c.source_count,
  c.sources
FROM (
  SELECT
    cluster_id,
    COUNT(*) AS source_count,
    array_agg(DISTINCT source ORDER BY source) AS sources
  FROM news_articles
  WHERE cluster_id IS NOT NULL
  GROUP BY cluster_id
) c
JOIN news_articles p
  ON p.cluster_id = c.cluster_id AND p.cluster_is_primary = TRUE;
