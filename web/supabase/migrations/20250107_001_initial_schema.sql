-- Initial database schema for shorted.com.au
-- Creates core tables for ASX short position tracking

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Create shorts table for daily short position data from ASIC
CREATE TABLE IF NOT EXISTS shorts (
    "DATE" timestamp NOT NULL,
    "PRODUCT" text NOT NULL,
    "PRODUCT_CODE" text NOT NULL,
    "REPORTED_SHORT_POSITIONS" numeric,
    "TOTAL_PRODUCT_IN_ISSUE" numeric,
    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" numeric
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts("PRODUCT_CODE", "DATE" DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_date_percent ON shorts("DATE" DESC, "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_product_code ON shorts("PRODUCT_CODE");
CREATE INDEX IF NOT EXISTS idx_shorts_date ON shorts("DATE" DESC);

-- Create company metadata table
CREATE TABLE IF NOT EXISTS "company-metadata" (
    company_name text,
    address text,
    summary text,
    details text,
    website text,
    stock_code text PRIMARY KEY,
    links text,
    images text,
    company_logo_link text,
    gcs_url text,
    industry text
);

CREATE INDEX IF NOT EXISTS idx_metadata_stock_code ON "company-metadata"(stock_code);
CREATE INDEX IF NOT EXISTS idx_metadata_industry ON "company-metadata"(industry);

-- Create subscriptions table for email notifications
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    email text NOT NULL UNIQUE,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Create stock prices table for market data
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

-- Create indexes for stock prices
CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_code ON stock_prices(stock_code);
CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_date ON stock_prices(stock_code, date DESC);

-- Create intraday stock prices table
CREATE TABLE IF NOT EXISTS stock_prices_intraday (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, timestamp)
);

-- Create indexes for intraday prices
CREATE INDEX IF NOT EXISTS idx_stock_prices_intraday_stock ON stock_prices_intraday(stock_code);
CREATE INDEX IF NOT EXISTS idx_stock_prices_intraday_timestamp ON stock_prices_intraday(timestamp DESC);

-- Create data quality tracking table
CREATE TABLE IF NOT EXISTS stock_data_quality (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    data_source VARCHAR(50),
    is_complete BOOLEAN DEFAULT TRUE,
    missing_fields TEXT[],
    anomaly_detected BOOLEAN DEFAULT FALSE,
    anomaly_details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date, data_source)
);

-- Create ingestion log table
CREATE TABLE IF NOT EXISTS stock_data_ingestion_log (
    id SERIAL PRIMARY KEY,
    batch_id UUID DEFAULT uuid_generate_v4(),
    data_source VARCHAR(50) NOT NULL,
    start_date DATE,
    end_date DATE,
    stocks_processed INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    error_details JSONB,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'running'
);

-- Create view for latest stock prices
CREATE OR REPLACE VIEW latest_stock_prices AS
SELECT DISTINCT ON (stock_code) 
    stock_code,
    date,
    open,
    high,
    low,
    close,
    adjusted_close,
    volume
FROM stock_prices
ORDER BY stock_code, date DESC;

-- Create view for stock price changes
CREATE OR REPLACE VIEW stock_price_changes AS
WITH price_data AS (
    SELECT 
        stock_code,
        date,
        close,
        LAG(close, 1) OVER (PARTITION BY stock_code ORDER BY date) as prev_day_close,
        LAG(close, 5) OVER (PARTITION BY stock_code ORDER BY date) as week_ago_close,
        LAG(close, 21) OVER (PARTITION BY stock_code ORDER BY date) as month_ago_close
    FROM stock_prices
)
SELECT 
    stock_code,
    date,
    close as current_price,
    ROUND(((close - prev_day_close) / NULLIF(prev_day_close, 0)) * 100, 2) as daily_change_pct,
    ROUND(((close - week_ago_close) / NULLIF(week_ago_close, 0)) * 100, 2) as weekly_change_pct,
    ROUND(((close - month_ago_close) / NULLIF(month_ago_close, 0)) * 100, 2) as monthly_change_pct
FROM price_data
WHERE date = (SELECT MAX(date) FROM stock_prices WHERE stock_code = price_data.stock_code);

-- Add update trigger for updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_stock_prices_updated_at BEFORE UPDATE
    ON stock_prices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Grant appropriate permissions (adjust as needed for your Supabase setup)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;