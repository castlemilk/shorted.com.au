CREATE TABLE asx_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(10) NOT NULL,
    announcement_date DATE NOT NULL,
    headline TEXT NOT NULL,
    is_price_sensitive BOOLEAN DEFAULT FALSE,
    announcement_type VARCHAR(50), -- trading_halt, capital_raise, director_dealing, earnings, guidance, takeover, other
    pdf_url TEXT,
    source VARCHAR(50) DEFAULT 'asx_announcements',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(stock_code, announcement_date, headline)
);

CREATE INDEX idx_asx_ann_stock_date ON asx_announcements(stock_code, announcement_date DESC);
CREATE INDEX idx_asx_ann_price_sens ON asx_announcements(announcement_date DESC) WHERE is_price_sensitive;
