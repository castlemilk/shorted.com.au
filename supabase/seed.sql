-- Seed data for testing

-- Insert sample company metadata
INSERT INTO company_metadata (stock_code, company_name, logo_url, industry, sector, market_cap) VALUES
('CBA', 'Commonwealth Bank of Australia', '', 'Banks', 'Financials', 170000000000),
('BHP', 'BHP Group Limited', '', 'Materials', 'Materials', 230000000000),
('CSL', 'CSL Limited', '', 'Pharmaceuticals', 'Health Care', 140000000000),
('ANZ', 'ANZ Banking Group', '', 'Banks', 'Financials', 80000000000),
('WBC', 'Westpac Banking Corp', '', 'Banks', 'Financials', 75000000000),
('NAB', 'National Australia Bank', '', 'Banks', 'Financials', 90000000000),
('WES', 'Wesfarmers Limited', '', 'Retailing', 'Consumer Discretionary', 70000000000),
('WOW', 'Woolworths Group', '', 'Food & Staples Retailing', 'Consumer Staples', 50000000000),
('TLS', 'Telstra Corporation', '', 'Telecommunication Services', 'Communication Services', 45000000000),
('RIO', 'Rio Tinto Limited', '', 'Materials', 'Materials', 180000000000)
ON CONFLICT (stock_code) DO NOTHING;

-- Insert sample shorts data (last 30 days)
DO $$
DECLARE
    i INTEGER;
    stock_codes TEXT[] := ARRAY['CBA', 'BHP', 'CSL', 'ANZ', 'WBC', 'NAB', 'WES', 'WOW', 'TLS', 'RIO'];
    stock_code TEXT;
BEGIN
    FOREACH stock_code IN ARRAY stock_codes LOOP
        FOR i IN 0..29 LOOP
            INSERT INTO shorts (
                date,
                product_code,
                product_name,
                reported_short_positions,
                reported_short_positions_percent_of_issued_shares,
                total_product_in_issue
            ) VALUES (
                CURRENT_DATE - INTERVAL '1 day' * i,
                stock_code,
                (SELECT company_name FROM company_metadata WHERE company_metadata.stock_code = stock_code),
                1000000 + (random() * 5000000)::INTEGER,
                5.0 + (random() * 15.0),
                100000000 + (random() * 500000000)::INTEGER
            ) ON CONFLICT (date, product_code) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- Insert sample stock prices
DO $$
DECLARE
    i INTEGER;
    stock_codes TEXT[] := ARRAY['CBA', 'BHP', 'CSL', 'ANZ', 'WBC', 'NAB', 'WES', 'WOW', 'TLS', 'RIO'];
    stock_code TEXT;
    base_price DECIMAL;
BEGIN
    FOREACH stock_code IN ARRAY stock_codes LOOP
        -- Set different base prices for each stock
        base_price := CASE stock_code
            WHEN 'CBA' THEN 100.0
            WHEN 'BHP' THEN 45.0
            WHEN 'CSL' THEN 290.0
            WHEN 'ANZ' THEN 28.0
            WHEN 'WBC' THEN 25.0
            WHEN 'NAB' THEN 33.0
            WHEN 'WES' THEN 65.0
            WHEN 'WOW' THEN 35.0
            WHEN 'TLS' THEN 4.0
            WHEN 'RIO' THEN 120.0
            ELSE 50.0
        END;
        
        FOR i IN 0..89 LOOP -- 90 days of price data
            INSERT INTO stock_prices (
                stock_code,
                date,
                open,
                high,
                low,
                close,
                volume
            ) VALUES (
                stock_code,
                CURRENT_DATE - INTERVAL '1 day' * i,
                base_price + (random() - 0.5) * 5,
                base_price + (random() * 5),
                base_price - (random() * 5),
                base_price + (random() - 0.5) * 3,
                1000000 + (random() * 10000000)::INTEGER
            ) ON CONFLICT (stock_code, date) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- Insert a test user
INSERT INTO users (email, name, provider, provider_id) VALUES
('test@example.com', 'Test User', 'email', 'test-user-id')
ON CONFLICT (email) DO NOTHING;

-- Insert a test watchlist
INSERT INTO watchlists (user_id, name, description)
SELECT id, 'My Watchlist', 'Stocks I am monitoring'
FROM users WHERE email = 'test@example.com'
ON CONFLICT DO NOTHING;

-- Add stocks to watchlist
INSERT INTO watchlist_items (watchlist_id, stock_code)
SELECT w.id, stock_code
FROM watchlists w
CROSS JOIN (VALUES ('CBA'), ('BHP'), ('CSL')) AS stocks(stock_code)
WHERE w.name = 'My Watchlist'
ON CONFLICT DO NOTHING;