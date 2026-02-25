-- Dividend history extracted from ASX announcements
CREATE TABLE IF NOT EXISTS dividend_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(10) NOT NULL,
    ex_date DATE NOT NULL,
    payment_date DATE,
    amount_per_share DECIMAL(10, 6) NOT NULL,
    franking_percentage DECIMAL(5, 2) DEFAULT 0.0,
    dividend_type VARCHAR(30) DEFAULT 'ordinary', -- 'ordinary', 'special', 'interim', 'final'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, ex_date, dividend_type)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_dividend_history_stock_code_ex_date
    ON dividend_history (stock_code, ex_date DESC);

CREATE INDEX IF NOT EXISTS idx_dividend_history_ex_date
    ON dividend_history (ex_date DESC);
