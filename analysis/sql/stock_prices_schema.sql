-- Stock price data schema for ASX stocks
-- This schema stores historical price data for Australian stocks

-- Create stock prices table
CREATE TABLE IF NOT EXISTS stock_prices (
    id BIGSERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2) NOT NULL,
    adjusted_close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);

-- Create indexes for performance
CREATE INDEX idx_stock_prices_stock_code ON stock_prices(stock_code);
CREATE INDEX idx_stock_prices_date ON stock_prices(date);
CREATE INDEX idx_stock_prices_stock_date ON stock_prices(stock_code, date DESC);

-- Create intraday prices table for more granular data
CREATE TABLE IF NOT EXISTS stock_prices_intraday (
    id BIGSERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2) NOT NULL,
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, timestamp)
);

-- Create indexes for intraday data
CREATE INDEX idx_stock_prices_intraday_stock ON stock_prices_intraday(stock_code);
CREATE INDEX idx_stock_prices_intraday_timestamp ON stock_prices_intraday(timestamp);
CREATE INDEX idx_stock_prices_intraday_stock_time ON stock_prices_intraday(stock_code, timestamp DESC);

-- Create data quality tracking table
CREATE TABLE IF NOT EXISTS stock_data_quality (
    id BIGSERIAL PRIMARY KEY,
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

-- Create data ingestion log table
CREATE TABLE IF NOT EXISTS stock_data_ingestion_log (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL,
    data_source VARCHAR(50) NOT NULL,
    start_date DATE,
    end_date DATE,
    stocks_processed INTEGER,
    records_inserted INTEGER,
    records_updated INTEGER,
    errors INTEGER,
    error_details JSONB,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'running' -- running, completed, failed
);

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for stock_prices table
CREATE TRIGGER update_stock_prices_updated_at BEFORE UPDATE ON stock_prices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- View for latest prices
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

-- View for price changes
CREATE OR REPLACE VIEW stock_price_changes AS
WITH price_data AS (
    SELECT 
        stock_code,
        date,
        close,
        LAG(close) OVER (PARTITION BY stock_code ORDER BY date) as prev_close,
        LAG(close, 7) OVER (PARTITION BY stock_code ORDER BY date) as week_ago_close,
        LAG(close, 30) OVER (PARTITION BY stock_code ORDER BY date) as month_ago_close
    FROM stock_prices
)
SELECT 
    stock_code,
    date,
    close,
    prev_close,
    CASE 
        WHEN prev_close IS NOT NULL AND prev_close != 0 
        THEN ROUND(((close - prev_close) / prev_close * 100)::numeric, 2)
        ELSE NULL 
    END as daily_change_percent,
    CASE 
        WHEN week_ago_close IS NOT NULL AND week_ago_close != 0 
        THEN ROUND(((close - week_ago_close) / week_ago_close * 100)::numeric, 2)
        ELSE NULL 
    END as weekly_change_percent,
    CASE 
        WHEN month_ago_close IS NOT NULL AND month_ago_close != 0 
        THEN ROUND(((close - month_ago_close) / month_ago_close * 100)::numeric, 2)
        ELSE NULL 
    END as monthly_change_percent
FROM price_data
ORDER BY stock_code, date DESC;