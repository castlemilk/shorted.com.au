-- Rollback news articles schema
DROP INDEX IF EXISTS idx_news_articles_sentiment;
DROP INDEX IF EXISTS idx_news_articles_price_sensitive;
DROP INDEX IF EXISTS idx_news_articles_source;
DROP INDEX IF EXISTS idx_news_articles_published_at;
DROP INDEX IF EXISTS idx_news_articles_stock_code_published;
DROP TABLE IF EXISTS news_articles;
