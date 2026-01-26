-- Test fixtures for shorted.com.au integration tests
-- This file contains sample ASIC short position data for testing

-- Sample short position data spanning multiple dates and stocks
INSERT INTO shorts (date, product_code, product_name, total_short_position, daily_short_volume, percent_of_total_shares) VALUES
-- Major Australian banks
('2024-01-15', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 12500000, 250000, 0.79),
('2024-01-16', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 12750000, 275000, 0.81),
('2024-01-17', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 12600000, 230000, 0.80),
('2024-01-18', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 12900000, 320000, 0.82),
('2024-01-19', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 13100000, 280000, 0.83),

('2024-01-15', 'ANZ', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP', 8750000, 180000, 0.29),
('2024-01-16', 'ANZ', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP', 8900000, 200000, 0.30),
('2024-01-17', 'ANZ', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP', 8650000, 150000, 0.28),
('2024-01-18', 'ANZ', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP', 9100000, 250000, 0.31),
('2024-01-19', 'ANZ', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP', 9050000, 220000, 0.31),

('2024-01-15', 'WBC', 'WESTPAC BANKING CORPORATION', 9500000, 200000, 0.27),
('2024-01-16', 'WBC', 'WESTPAC BANKING CORPORATION', 9750000, 250000, 0.28),
('2024-01-17', 'WBC', 'WESTPAC BANKING CORPORATION', 9400000, 180000, 0.27),
('2024-01-18', 'WBC', 'WESTPAC BANKING CORPORATION', 9800000, 300000, 0.28),
('2024-01-19', 'WBC', 'WESTPAC BANKING CORPORATION', 9900000, 280000, 0.29),

('2024-01-15', 'NAB', 'NATIONAL AUSTRALIA BANK LIMITED', 7800000, 160000, 0.18),
('2024-01-16', 'NAB', 'NATIONAL AUSTRALIA BANK LIMITED', 8000000, 200000, 0.19),
('2024-01-17', 'NAB', 'NATIONAL AUSTRALIA BANK LIMITED', 7750000, 140000, 0.18),
('2024-01-18', 'NAB', 'NATIONAL AUSTRALIA BANK LIMITED', 8200000, 240000, 0.19),
('2024-01-19', 'NAB', 'NATIONAL AUSTRALIA BANK LIMITED', 8150000, 210000, 0.19),

-- Mining companies
('2024-01-15', 'BHP', 'BHP GROUP LIMITED', 45000000, 1200000, 2.89),
('2024-01-16', 'BHP', 'BHP GROUP LIMITED', 46500000, 1500000, 2.98),
('2024-01-17', 'BHP', 'BHP GROUP LIMITED', 44800000, 900000, 2.87),
('2024-01-18', 'BHP', 'BHP GROUP LIMITED', 47200000, 1800000, 3.02),
('2024-01-19', 'BHP', 'BHP GROUP LIMITED', 46800000, 1400000, 3.00),

('2024-01-15', 'RIO', 'RIO TINTO LIMITED', 22500000, 600000, 1.38),
('2024-01-16', 'RIO', 'RIO TINTO LIMITED', 23200000, 750000, 1.43),
('2024-01-17', 'RIO', 'RIO TINTO LIMITED', 22100000, 450000, 1.36),
('2024-01-18', 'RIO', 'RIO TINTO LIMITED', 23800000, 900000, 1.47),
('2024-01-19', 'RIO', 'RIO TINTO LIMITED', 23400000, 700000, 1.44),

('2024-01-15', 'FMG', 'FORTESCUE METALS GROUP LTD', 35000000, 2000000, 11.25),
('2024-01-16', 'FMG', 'FORTESCUE METALS GROUP LTD', 36500000, 2500000, 11.73),
('2024-01-17', 'FMG', 'FORTESCUE METALS GROUP LTD', 34200000, 1500000, 10.99),
('2024-01-18', 'FMG', 'FORTESCUE METALS GROUP LTD', 37800000, 3000000, 12.15),
('2024-01-19', 'FMG', 'FORTESCUE METALS GROUP LTD', 37200000, 2200000, 11.96),

-- Healthcare/Biotech
('2024-01-15', 'CSL', 'CSL LIMITED', 8500000, 180000, 1.87),
('2024-01-16', 'CSL', 'CSL LIMITED', 8750000, 250000, 1.93),
('2024-01-17', 'CSL', 'CSL LIMITED', 8300000, 120000, 1.82),
('2024-01-18', 'CSL', 'CSL LIMITED', 9000000, 350000, 1.98),
('2024-01-19', 'CSL', 'CSL LIMITED', 8900000, 280000, 1.96),

('2024-01-15', 'COH', 'COCHLEAR LIMITED', 1250000, 25000, 1.95),
('2024-01-16', 'COH', 'COCHLEAR LIMITED', 1300000, 50000, 2.03),
('2024-01-17', 'COH', 'COCHLEAR LIMITED', 1200000, 15000, 1.87),
('2024-01-18', 'COH', 'COCHLEAR LIMITED', 1350000, 75000, 2.10),
('2024-01-19', 'COH', 'COCHLEAR LIMITED', 1320000, 45000, 2.06),

-- Technology
('2024-01-15', 'XRO', 'XERO LIMITED', 3500000, 150000, 2.40),
('2024-01-16', 'XRO', 'XERO LIMITED', 3750000, 250000, 2.57),
('2024-01-17', 'XRO', 'XERO LIMITED', 3300000, 100000, 2.26),
('2024-01-18', 'XRO', 'XERO LIMITED', 3900000, 350000, 2.67),
('2024-01-19', 'XRO', 'XERO LIMITED', 3800000, 250000, 2.60),

('2024-01-15', 'APT', 'AFTERPAY LIMITED', 15000000, 800000, 4.55),
('2024-01-16', 'APT', 'AFTERPAY LIMITED', 16200000, 1200000, 4.91),
('2024-01-17', 'APT', 'AFTERPAY LIMITED', 14500000, 600000, 4.40),
('2024-01-18', 'APT', 'AFTERPAY LIMITED', 17500000, 1500000, 5.30),
('2024-01-19', 'APT', 'AFTERPAY LIMITED', 16800000, 1000000, 5.09),

-- Retail
('2024-01-15', 'WOW', 'WOOLWORTHS GROUP LIMITED', 12000000, 300000, 0.76),
('2024-01-16', 'WOW', 'WOOLWORTHS GROUP LIMITED', 12500000, 500000, 0.79),
('2024-01-17', 'WOW', 'WOOLWORTHS GROUP LIMITED', 11800000, 200000, 0.75),
('2024-01-18', 'WOW', 'WOOLWORTHS GROUP LIMITED', 13000000, 700000, 0.83),
('2024-01-19', 'WOW', 'WOOLWORTHS GROUP LIMITED', 12700000, 400000, 0.81),

('2024-01-15', 'COL', 'COLES GROUP LIMITED', 8500000, 250000, 0.64),
('2024-01-16', 'COL', 'COLES GROUP LIMITED', 8800000, 350000, 0.66),
('2024-01-17', 'COL', 'COLES GROUP LIMITED', 8200000, 150000, 0.62),
('2024-01-18', 'COL', 'COLES GROUP LIMITED', 9200000, 500000, 0.69),
('2024-01-19', 'COL', 'COLES GROUP LIMITED', 9000000, 300000, 0.68),

-- Telecom
('2024-01-15', 'TLS', 'TELSTRA CORPORATION LIMITED', 48000000, 2000000, 3.26),
('2024-01-16', 'TLS', 'TELSTRA CORPORATION LIMITED', 49500000, 2500000, 3.36),
('2024-01-17', 'TLS', 'TELSTRA CORPORATION LIMITED', 47200000, 1500000, 3.21),
('2024-01-18', 'TLS', 'TELSTRA CORPORATION LIMITED', 51000000, 3500000, 3.47),
('2024-01-19', 'TLS', 'TELSTRA CORPORATION LIMITED', 50200000, 2800000, 3.41),

-- Some high short interest stocks for testing edge cases
('2024-01-15', 'ZIP', 'ZIP CO LIMITED', 125000000, 8000000, 25.50),
('2024-01-16', 'ZIP', 'ZIP CO LIMITED', 130000000, 10000000, 26.52),
('2024-01-17', 'ZIP', 'ZIP CO LIMITED', 120000000, 6000000, 24.49),
('2024-01-18', 'ZIP', 'ZIP CO LIMITED', 135000000, 12000000, 27.55),
('2024-01-19', 'ZIP', 'ZIP CO LIMITED', 132000000, 9000000, 26.94),

('2024-01-15', 'SPT', 'SPLITIT PAYMENTS LTD', 45000000, 3000000, 18.75),
('2024-01-16', 'SPT', 'SPLITIT PAYMENTS LTD', 48000000, 4000000, 20.00),
('2024-01-17', 'SPT', 'SPLITIT PAYMENTS LTD', 42000000, 2000000, 17.50),
('2024-01-18', 'SPT', 'SPLITIT PAYMENTS LTD', 52000000, 5000000, 21.67),
('2024-01-19', 'SPT', 'SPLITIT PAYMENTS LTD', 50000000, 3500000, 20.83);

-- Sample company metadata
INSERT INTO "company-metadata" (stock_code, company_name, sector, industry, market_cap, logo_url, website, description, exchange) VALUES
-- Big 4 Banks
('CBA', 'Commonwealth Bank of Australia', 'Financial Services', 'Banks', 180000000000, 'https://logos.com/cba.png', 'https://commbank.com.au', 'Australia''s largest bank providing financial services', 'ASX'),
('ANZ', 'Australia and New Zealand Banking Group', 'Financial Services', 'Banks', 75000000000, 'https://logos.com/anz.png', 'https://anz.com.au', 'Major Australian bank with operations across Asia-Pacific', 'ASX'),
('WBC', 'Westpac Banking Corporation', 'Financial Services', 'Banks', 85000000000, 'https://logos.com/wbc.png', 'https://westpac.com.au', 'One of Australia''s Big Four banks', 'ASX'),
('NAB', 'National Australia Bank Limited', 'Financial Services', 'Banks', 95000000000, 'https://logos.com/nab.png', 'https://nab.com.au', 'Major Australian bank serving retail and business customers', 'ASX'),

-- Mining
('BHP', 'BHP Group Limited', 'Materials', 'Mining', 200000000000, 'https://logos.com/bhp.png', 'https://bhp.com', 'Global mining company producing iron ore, copper, coal', 'ASX'),
('RIO', 'Rio Tinto Limited', 'Materials', 'Mining', 120000000000, 'https://logos.com/rio.png', 'https://riotinto.com', 'International mining group focused on iron ore and aluminum', 'ASX'),
('FMG', 'Fortescue Metals Group Ltd', 'Materials', 'Iron Ore Mining', 45000000000, 'https://logos.com/fmg.png', 'https://fmgl.com.au', 'Leading iron ore producer in the Pilbara region', 'ASX'),

-- Healthcare
('CSL', 'CSL Limited', 'Healthcare', 'Biotechnology', 150000000000, 'https://logos.com/csl.png', 'https://csl.com', 'Global biotechnology company developing vaccines and plasma therapies', 'ASX'),
('COH', 'Cochlear Limited', 'Healthcare', 'Medical Devices', 15000000000, 'https://logos.com/coh.png', 'https://cochlear.com', 'Leading manufacturer of hearing implants', 'ASX'),

-- Technology
('XRO', 'Xero Limited', 'Technology', 'Software', 12000000000, 'https://logos.com/xro.png', 'https://xero.com', 'Cloud-based accounting software platform', 'ASX'),
('APT', 'Afterpay Limited', 'Technology', 'Financial Technology', 8000000000, 'https://logos.com/apt.png', 'https://afterpay.com', 'Buy now, pay later payment platform', 'ASX'),

-- Retail
('WOW', 'Woolworths Group Limited', 'Consumer Staples', 'Retail', 45000000000, 'https://logos.com/wow.png', 'https://woolworthsgroup.com.au', 'Major Australian supermarket and retail chain', 'ASX'),
('COL', 'Coles Group Limited', 'Consumer Staples', 'Retail', 18000000000, 'https://logos.com/col.png', 'https://coles.com.au', 'Australian supermarket, retail and consumer services chain', 'ASX'),

-- Telecom
('TLS', 'Telstra Corporation Limited', 'Telecommunications', 'Telecom Services', 32000000000, 'https://logos.com/tls.png', 'https://telstra.com.au', 'Australia''s largest telecommunications company', 'ASX'),

-- High short interest stocks
('ZIP', 'Zip Co Limited', 'Technology', 'Financial Technology', 500000000, 'https://logos.com/zip.png', 'https://zip.co', 'Buy now, pay later payment platform', 'ASX'),
('SPT', 'Splitit Payments Ltd', 'Technology', 'Financial Technology', 200000000, 'https://logos.com/spt.png', 'https://splitit.com', 'Credit card-based payment solution platform', 'ASX');

-- Sample subscription data
INSERT INTO subscriptions (email, status) VALUES
('test1@example.com', 'active'),
('test2@example.com', 'active'),
('test3@example.com', 'inactive'),
('premium@example.com', 'active'),
('investor@example.com', 'active');