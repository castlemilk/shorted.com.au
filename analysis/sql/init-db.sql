-- Database initialization script for development
-- Based on the schema defined in ARCHITECTURE.md

-- Create the shorts table
CREATE TABLE IF NOT EXISTS shorts (
    "DATE" TIMESTAMP WITHOUT TIME ZONE,
    "PRODUCT" TEXT,
    "PRODUCT_CODE" TEXT,
    "REPORTED_SHORT_POSITIONS" DOUBLE PRECISION,
    "TOTAL_PRODUCT_IN_ISSUE" DOUBLE PRECISION,
    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DOUBLE PRECISION
);

-- Create the company-metadata table with all required columns for search
CREATE TABLE IF NOT EXISTS "company-metadata" (
    company_name TEXT,
    address TEXT,
    summary TEXT,
    details TEXT,
    website TEXT,
    stock_code TEXT PRIMARY KEY,
    links TEXT,
    images TEXT,
    company_logo_link TEXT,
    gcs_url TEXT,
    logo_gcs_url TEXT,
    industry TEXT,
    tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    search_vector TSVECTOR,
    -- Columns below keep this shape convergent with services/migrations/000001
    sector VARCHAR(100),
    market_cap BIGINT,
    logo_url VARCHAR(500),
    description TEXT,
    exchange VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create the subscriptions table (shape must match services/migrations/000001)
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create the stock_prices table (required by search query's valid_stocks CTE)
CREATE TABLE IF NOT EXISTS stock_prices (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2),
    adjusted_close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts ("PRODUCT_CODE", "DATE");
CREATE INDEX IF NOT EXISTS idx_shorts_date_percent ON shorts ("DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");
CREATE INDEX IF NOT EXISTS idx_company_metadata_search_vector ON "company-metadata" USING GIN (search_vector);

-- Insert sample metadata with all required fields for search functionality
INSERT INTO "company-metadata" (company_name, stock_code, industry, tags, search_vector, logo_gcs_url) VALUES 
    ('Sample Company A', 'SMPA', 'Technology', ARRAY['tech', 'sample']::TEXT[], to_tsvector('english', 'Sample Company A Technology tech sample'), ''),
    ('Sample Company B', 'SMPB', 'Finance', ARRAY['finance', 'sample']::TEXT[], to_tsvector('english', 'Sample Company B Finance finance sample'), ''),
    ('Sample Company C', 'SMPC', 'Healthcare', ARRAY['healthcare', 'sample']::TEXT[], to_tsvector('english', 'Sample Company C Healthcare healthcare sample'), ''),
    ('Commonwealth Bank of Australia', 'CBA', 'Financials', ARRAY['bank', 'finance', 'big4']::TEXT[], to_tsvector('english', 'Commonwealth Bank of Australia CBA Financials bank finance big4'), ''),
    ('BHP Group Limited', 'BHP', 'Materials', ARRAY['mining', 'resources', 'asx20']::TEXT[], to_tsvector('english', 'BHP Group Limited Materials mining resources asx20'), ''),
    ('ResMed Inc', 'RMD', 'Healthcare', ARRAY['medical', 'devices', 'healthcare']::TEXT[], to_tsvector('english', 'ResMed Inc Healthcare medical devices healthcare'), ''),
    ('Red Mount Mining Ltd', 'RMX', 'Materials', ARRAY['mining', 'exploration']::TEXT[], to_tsvector('english', 'Red Mount Mining Ltd Materials mining exploration'), '')
ON CONFLICT (stock_code) DO UPDATE SET 
    company_name = EXCLUDED.company_name,
    industry = EXCLUDED.industry,
    tags = EXCLUDED.tags,
    search_vector = EXCLUDED.search_vector;

INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES 
    -- Sample test data
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company A', 'SMPA', 1000000, 10000000, 10.0),
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company B', 'SMPB', 500000, 5000000, 10.0),
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company C', 'SMPC', 750000, 7500000, 10.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company A', 'SMPA', 900000, 10000000, 9.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company B', 'SMPB', 600000, 5000000, 12.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company C', 'SMPC', 800000, 7500000, 10.7),
    -- Real ASX stocks for integration tests
    (CURRENT_DATE - INTERVAL '1 day', 'COMMONWEALTH BANK. ORDINARY', 'CBA', 17639252, 1673462400, 1.054057),
    (CURRENT_DATE - INTERVAL '2 days', 'COMMONWEALTH BANK. ORDINARY', 'CBA', 17651856, 1673462400, 1.054811),
    (CURRENT_DATE - INTERVAL '1 day', 'BHP GROUP LIMITED ORDINARY', 'BHP', 48123456, 2500000000, 1.924938),
    (CURRENT_DATE - INTERVAL '2 days', 'BHP GROUP LIMITED ORDINARY', 'BHP', 48234567, 2500000000, 1.929383),
    (CURRENT_DATE - INTERVAL '1 day', 'RESMED INC CDI 10:1 FOR. EXEMPT', 'RMD', 830926, 583681640, 0.14235945),
    (CURRENT_DATE - INTERVAL '2 days', 'RESMED INC CDI 10:1 FOR. EXEMPT', 'RMD', 825000, 583681640, 0.14134567),
    (CURRENT_DATE - INTERVAL '1 day', 'RED MOUNT MIN LTD ORDINARY', 'RMX', 121046, 464957796, 0.02603376),
    (CURRENT_DATE - INTERVAL '2 days', 'RED MOUNT MIN LTD ORDINARY', 'RMX', 120500, 464957796, 0.02591628)
ON CONFLICT DO NOTHING;

-- Insert sample stock prices so search valid_stocks CTE finds these stocks
INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume) VALUES
    ('CBA', CURRENT_DATE - INTERVAL '1 day', 140.00, 141.50, 139.50, 141.00, 141.00, 5000000),
    ('CBA', CURRENT_DATE - INTERVAL '2 days', 139.00, 140.50, 138.50, 140.00, 140.00, 4800000),
    ('BHP', CURRENT_DATE - INTERVAL '1 day', 45.00, 45.80, 44.50, 45.50, 45.50, 8000000),
    ('BHP', CURRENT_DATE - INTERVAL '2 days', 44.50, 45.20, 44.00, 45.00, 45.00, 7500000),
    ('RMD', CURRENT_DATE - INTERVAL '1 day', 38.00, 38.50, 37.50, 38.20, 38.20, 1200000),
    ('RMD', CURRENT_DATE - INTERVAL '2 days', 37.50, 38.10, 37.00, 38.00, 38.00, 1100000),
    ('RMX', CURRENT_DATE - INTERVAL '1 day', 0.05, 0.06, 0.04, 0.05, 0.05, 500000),
    ('RMX', CURRENT_DATE - INTERVAL '2 days', 0.04, 0.05, 0.04, 0.05, 0.05, 450000),
    ('SMPA', CURRENT_DATE - INTERVAL '1 day', 10.00, 10.50, 9.80, 10.20, 10.20, 200000),
    ('SMPB', CURRENT_DATE - INTERVAL '1 day', 25.00, 25.50, 24.50, 25.20, 25.20, 300000),
    ('SMPC', CURRENT_DATE - INTERVAL '1 day', 15.00, 15.30, 14.80, 15.10, 15.10, 150000)
ON CONFLICT (stock_code, date) DO NOTHING;