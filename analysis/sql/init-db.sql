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

-- Create the company-metadata table
CREATE TABLE IF NOT EXISTS "company-metadata" (
    company_name TEXT,
    address TEXT,
    summary TEXT,
    details TEXT,
    website TEXT,
    stock_code TEXT,
    links TEXT,
    images TEXT,
    company_logo_link TEXT,
    gcs_url TEXT,
    industry TEXT
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

-- Insert some sample data so the application can display something
INSERT INTO "company-metadata" (company_name, stock_code, industry) VALUES 
    ('Sample Company A', 'SMPA', 'Technology'),
    ('Sample Company B', 'SMPB', 'Finance'),
    ('Sample Company C', 'SMPC', 'Healthcare')
ON CONFLICT DO NOTHING;

INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES 
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company A', 'SMPA', 1000000, 10000000, 10.0),
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company B', 'SMPB', 500000, 5000000, 10.0),
    (CURRENT_DATE - INTERVAL '1 day', 'Sample Company C', 'SMPC', 750000, 7500000, 10.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company A', 'SMPA', 900000, 10000000, 9.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company B', 'SMPB', 600000, 5000000, 12.0),
    (CURRENT_DATE - INTERVAL '2 days', 'Sample Company C', 'SMPC', 800000, 7500000, 10.7)
ON CONFLICT DO NOTHING; 