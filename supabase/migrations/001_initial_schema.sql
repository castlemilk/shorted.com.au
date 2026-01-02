-- Initial schema for Shorted application

-- Create tables if they don't exist
CREATE TABLE IF NOT EXISTS shorts (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    product_code VARCHAR(10) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    reported_short_positions BIGINT,
    reported_short_positions_percent_of_issued_shares DECIMAL(10, 4),
    total_product_in_issue BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, product_code)
);

CREATE TABLE IF NOT EXISTS company_metadata (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) UNIQUE NOT NULL,
    company_name VARCHAR(255),
    logo_url VARCHAR(500),
    industry VARCHAR(100),
    sector VARCHAR(100),
    market_cap BIGINT,
    description TEXT,
    website VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_prices (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 4),
    high DECIMAL(10, 4),
    low DECIMAL(10, 4),
    close DECIMAL(10, 4),
    volume BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    avatar_url VARCHAR(500),
    provider VARCHAR(50),
    provider_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlists (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlist_items (
    id SERIAL PRIMARY KEY,
    watchlist_id INTEGER REFERENCES watchlists(id) ON DELETE CASCADE,
    stock_code VARCHAR(10) NOT NULL,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(watchlist_id, stock_code)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts(product_code, date DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_date_percent ON shorts(date, reported_short_positions_percent_of_issued_shares DESC);
CREATE INDEX IF NOT EXISTS idx_stock_prices_code_date ON stock_prices(stock_code, date DESC);
CREATE INDEX IF NOT EXISTS idx_watchlist_items_stock ON watchlist_items(stock_code);

-- Create views for common queries
CREATE OR REPLACE VIEW latest_shorts AS
SELECT DISTINCT ON (product_code)
    product_code,
    product_name,
    date,
    reported_short_positions,
    reported_short_positions_percent_of_issued_shares,
    total_product_in_issue
FROM shorts
ORDER BY product_code, date DESC;

CREATE OR REPLACE VIEW top_shorted_stocks AS
SELECT 
    s.product_code,
    s.product_name,
    s.reported_short_positions_percent_of_issued_shares as short_percent,
    s.date,
    cm.logo_url,
    cm.industry,
    cm.sector
FROM latest_shorts s
LEFT JOIN company_metadata cm ON s.product_code = cm.stock_code
ORDER BY s.reported_short_positions_percent_of_issued_shares DESC
LIMIT 20;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_shorts_updated_at BEFORE UPDATE ON shorts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_company_metadata_updated_at BEFORE UPDATE ON company_metadata
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_watchlists_updated_at BEFORE UPDATE ON watchlists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();