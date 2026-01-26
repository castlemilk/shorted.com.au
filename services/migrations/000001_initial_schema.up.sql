-- Create shorts table matching production schema (uppercase columns from data sync)
CREATE TABLE IF NOT EXISTS shorts (
    "DATE" timestamp without time zone,
    "PRODUCT" text,
    "PRODUCT_CODE" text,
    "REPORTED_SHORT_POSITIONS" double precision,
    "TOTAL_PRODUCT_IN_ISSUE" double precision,
    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" double precision
);

-- Create indexes for shorts
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts("PRODUCT_CODE", "DATE" DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_date_percent ON shorts("DATE" DESC, "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_product_code ON shorts("PRODUCT_CODE");
CREATE INDEX IF NOT EXISTS idx_shorts_date ON shorts("DATE");

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
