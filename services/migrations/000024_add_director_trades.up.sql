-- Director trades extracted from ASX Appendix 3Y announcements
CREATE TABLE IF NOT EXISTS director_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(10) NOT NULL,
    director_name TEXT NOT NULL,
    trade_type VARCHAR(20) NOT NULL,       -- 'buy', 'sell', 'exercise_options'
    shares_traded BIGINT NOT NULL,
    price_per_share DECIMAL(12, 4),
    total_value DECIMAL(18, 2),
    trade_date DATE NOT NULL,
    announcement_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_director_trades_stock_code_date
    ON director_trades (stock_code, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_director_trades_trade_date
    ON director_trades (trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_director_trades_type
    ON director_trades (trade_type, trade_date DESC);
