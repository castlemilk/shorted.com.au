INSERT INTO "company-metadata" (stock_code, industry, tags, logo_gcs_url) VALUES
('CBA', 'Banks', ARRAY['financial-services', 'banking', 'finance'], NULL),
('NAB', 'Banks', ARRAY['financial-services', 'banking', 'finance'], NULL),
('WBC', 'Banks', ARRAY['financial-services', 'banking', 'finance'], NULL),
('ANZ', 'Banks', ARRAY['financial-services', 'banking', 'finance'], NULL),
('BHP', 'Materials', ARRAY['mining', 'resources', 'iron-ore'], NULL),
('CSL', 'Health Care', ARRAY['biotech', 'pharmaceuticals', 'health'], NULL)
ON CONFLICT (stock_code) DO UPDATE SET
industry = EXCLUDED.industry,
tags = EXCLUDED.tags,
logo_gcs_url = EXCLUDED.logo_gcs_url;

INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES
('2025-11-28', 'COMMONWEALTH BANK OF AUSTRALIA.', 'CBA', 1000000, 100000000, 1.0),
('2025-11-28', 'NATIONAL AUSTRALIA BANK LIMITED', 'NAB', 2000000, 100000000, 2.0),
('2025-11-28', 'WESTPAC BANKING CORPORATION', 'WBC', 1500000, 100000000, 1.5),
('2025-11-28', 'ANZ GROUP HOLDINGS LIMITED', 'ANZ', 1200000, 100000000, 1.2),
('2025-11-28', 'BHP GROUP LIMITED', 'BHP', 500000, 100000000, 0.5),
('2025-11-28', 'CSL LIMITED', 'CSL', 800000, 100000000, 0.8);


