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
    search_vector TSVECTOR
);

-- Create the subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
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