-- Create shorts table if not exists
CREATE TABLE IF NOT EXISTS shorts (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    product_code VARCHAR(50) NOT NULL,
    product_name VARCHAR(255),
    total_short_position BIGINT,
    daily_short_volume BIGINT,
    percent_of_total_shares DECIMAL(5, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_shorts_date_product UNIQUE(date, product_code)
);

-- Create indexes for shorts
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts(product_code, date DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_date_percent ON shorts(date DESC, percent_of_total_shares DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_product_code ON shorts(product_code);
CREATE INDEX IF NOT EXISTS idx_shorts_date ON shorts(date);

-- Create company metadata table
CREATE TABLE IF NOT EXISTS "company-metadata" (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(50) UNIQUE NOT NULL,
    company_name VARCHAR(255),
    sector VARCHAR(100),
    industry VARCHAR(100),
    market_cap BIGINT,
    logo_url VARCHAR(500),
    website VARCHAR(500),
    description TEXT,
    exchange VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for company metadata
CREATE INDEX IF NOT EXISTS idx_metadata_stock_code ON "company-metadata"(stock_code);

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);