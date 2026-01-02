-- Seed data for development and testing
-- This file contains sample data for the shorted.com.au database

-- Insert sample company metadata for popular ASX stocks
INSERT INTO "company-metadata" (company_name, stock_code, summary, industry, website) VALUES
    ('Commonwealth Bank of Australia', 'CBA', 'Australia''s largest bank by market capitalisation', 'Financials', 'https://www.commbank.com.au'),
    ('BHP Group Limited', 'BHP', 'Global resources company', 'Materials', 'https://www.bhp.com'),
    ('CSL Limited', 'CSL', 'Global biotechnology company', 'Health Care', 'https://www.csl.com'),
    ('National Australia Bank', 'NAB', 'One of Australia''s big four banks', 'Financials', 'https://www.nab.com.au'),
    ('Westpac Banking Corporation', 'WBC', 'Australian bank and financial services provider', 'Financials', 'https://www.westpac.com.au'),
    ('ANZ Banking Group', 'ANZ', 'Major Australian and New Zealand banking group', 'Financials', 'https://www.anz.com.au'),
    ('Macquarie Group', 'MQG', 'Global financial services group', 'Financials', 'https://www.macquarie.com'),
    ('Wesfarmers Limited', 'WES', 'Australian conglomerate', 'Consumer Discretionary', 'https://www.wesfarmers.com.au'),
    ('Telstra Corporation', 'TLS', 'Australia''s largest telecommunications company', 'Communication Services', 'https://www.telstra.com.au'),
    ('Woolworths Group', 'WOW', 'Australian retail company', 'Consumer Staples', 'https://www.woolworthsgroup.com.au'),
    ('Rio Tinto Limited', 'RIO', 'Mining and metals corporation', 'Materials', 'https://www.riotinto.com'),
    ('Fortescue Metals Group', 'FMG', 'Iron ore production and exploration company', 'Materials', 'https://www.fortescue.com'),
    ('Transurban Group', 'TCL', 'Toll road operator', 'Industrials', 'https://www.transurban.com'),
    ('Goodman Group', 'GMG', 'Industrial property specialist', 'Real Estate', 'https://www.goodman.com'),
    ('Aristocrat Leisure', 'ALL', 'Gaming machine manufacturer', 'Consumer Discretionary', 'https://www.aristocrat.com')
ON CONFLICT (stock_code) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    summary = EXCLUDED.summary,
    industry = EXCLUDED.industry,
    website = EXCLUDED.website;

-- Insert sample short position data (last 7 days for demonstration)
-- Note: In production, this data comes from ASIC CSV files
WITH dates AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '7 days',
        CURRENT_DATE,
        INTERVAL '1 day'
    )::date AS date
),
stocks AS (
    SELECT stock_code, company_name 
    FROM "company-metadata"
),
sample_data AS (
    SELECT 
        d.date::timestamp AS "DATE",
        s.company_name AS "PRODUCT",
        s.stock_code AS "PRODUCT_CODE",
        -- Generate random but realistic short position data
        ROUND((RANDOM() * 500000000)::numeric, 0) AS "REPORTED_SHORT_POSITIONS",
        ROUND((RANDOM() * 5000000000 + 1000000000)::numeric, 0) AS "TOTAL_PRODUCT_IN_ISSUE",
        ROUND((RANDOM() * 10 + 0.5)::numeric, 2) AS "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
    FROM dates d
    CROSS JOIN stocks s
)
INSERT INTO shorts 
SELECT * FROM sample_data
ON CONFLICT DO NOTHING;

-- Insert sample stock price data for the last 30 days
WITH dates AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '30 days',
        CURRENT_DATE,
        INTERVAL '1 day'
    )::date AS date
),
stocks AS (
    SELECT stock_code FROM "company-metadata"
),
base_prices AS (
    SELECT 
        stock_code,
        CASE stock_code
            WHEN 'CBA' THEN 100.00
            WHEN 'BHP' THEN 45.00
            WHEN 'CSL' THEN 280.00
            WHEN 'NAB' THEN 32.00
            WHEN 'WBC' THEN 25.00
            WHEN 'ANZ' THEN 28.00
            WHEN 'MQG' THEN 180.00
            WHEN 'WES' THEN 65.00
            WHEN 'TLS' THEN 3.80
            WHEN 'WOW' THEN 35.00
            WHEN 'RIO' THEN 120.00
            WHEN 'FMG' THEN 22.00
            WHEN 'TCL' THEN 13.00
            WHEN 'GMG' THEN 20.00
            WHEN 'ALL' THEN 40.00
            ELSE 50.00
        END AS base_price
    FROM stocks
),
price_data AS (
    SELECT 
        s.stock_code,
        d.date,
        -- Generate realistic price movements
        ROUND((bp.base_price * (1 + (RANDOM() - 0.5) * 0.02))::numeric, 2) AS open,
        ROUND((bp.base_price * (1 + (RANDOM() - 0.45) * 0.03))::numeric, 2) AS high,
        ROUND((bp.base_price * (1 + (RANDOM() - 0.55) * 0.03))::numeric, 2) AS low,
        ROUND((bp.base_price * (1 + (RANDOM() - 0.5) * 0.02))::numeric, 2) AS close,
        ROUND((bp.base_price * (1 + (RANDOM() - 0.5) * 0.02))::numeric, 2) AS adjusted_close,
        ROUND((RANDOM() * 50000000)::numeric, 0) AS volume
    FROM dates d
    CROSS JOIN base_prices bp
    JOIN stocks s ON s.stock_code = bp.stock_code
)
INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
SELECT * FROM price_data
ON CONFLICT (stock_code, date) DO UPDATE SET
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low = EXCLUDED.low,
    close = EXCLUDED.close,
    adjusted_close = EXCLUDED.adjusted_close,
    volume = EXCLUDED.volume,
    updated_at = CURRENT_TIMESTAMP;

-- Log the data ingestion
INSERT INTO stock_data_ingestion_log (
    data_source,
    start_date,
    end_date,
    stocks_processed,
    records_inserted,
    status,
    completed_at
) VALUES (
    'seed_data',
    CURRENT_DATE - INTERVAL '30 days',
    CURRENT_DATE,
    15,
    (SELECT COUNT(*) FROM stock_prices WHERE date >= CURRENT_DATE - INTERVAL '30 days'),
    'completed',
    CURRENT_TIMESTAMP
);