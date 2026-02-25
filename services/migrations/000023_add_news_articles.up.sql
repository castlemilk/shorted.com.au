-- News articles aggregated from multiple sources (ASX, RSS feeds, etc.)
CREATE TABLE IF NOT EXISTS news_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(10) NOT NULL,
    source VARCHAR(50) NOT NULL,          -- 'asx', 'stockhead', 'livewire', 'afr'
    headline TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE NOT NULL,
    sentiment VARCHAR(20),                -- 'positive', 'negative', 'neutral'
    relevance_score DOUBLE PRECISION DEFAULT 0.0,
    is_price_sensitive BOOLEAN DEFAULT FALSE,
    summary TEXT,
    tags JSONB DEFAULT '[]'::jsonb,
    scraped_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(url)                           -- Dedup by URL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_news_articles_stock_code_published
    ON news_articles (stock_code, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_articles_published_at
    ON news_articles (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_articles_source
    ON news_articles (source);

CREATE INDEX IF NOT EXISTS idx_news_articles_price_sensitive
    ON news_articles (is_price_sensitive, published_at DESC)
    WHERE is_price_sensitive = TRUE;

CREATE INDEX IF NOT EXISTS idx_news_articles_sentiment
    ON news_articles (sentiment, published_at DESC);
