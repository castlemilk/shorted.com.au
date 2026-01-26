-- Migration: Proper Financial Reports Storage
-- Stores both original URLs (source of truth) and GCS backup URLs

-- First, ensure stock_code has a unique constraint (required for foreign key)
ALTER TABLE "company-metadata" ADD CONSTRAINT unique_stock_code UNIQUE (stock_code);

-- Modify the financial_reports JSONB structure to include both original and GCS URLs
-- Structure:
-- {
--   "type": "annual_report",
--   "title": "2024 Annual Report",
--   "date": "2024-06-30",
--   "source_url": "https://company.com/reports/2024-annual-report.pdf",  -- ORIGINAL (source of truth)
--   "gcs_url": "https://storage.googleapis.com/shorted-financial-reports/CBA/2024-annual-report.pdf",  -- OUR BACKUP
--   "gcs_synced_at": "2025-01-15T10:00:00Z",
--   "file_size": 1234567,
--   "file_hash": "abc123...",  -- SHA256 hash for integrity
--   "source": "smart_crawler"
-- }

-- Add GCS bucket reference configuration
COMMENT ON COLUMN "company-metadata".financial_reports IS 
'Array of financial report links with both source URLs (original) and GCS backup URLs. 
Structure: [{type, title, date, source_url, gcs_url, gcs_synced_at, file_size, file_hash, source}]';

-- Create a dedicated table for tracking report sync status (optional, for better tracking)
CREATE TABLE IF NOT EXISTS financial_report_files (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL REFERENCES "company-metadata"(stock_code) ON DELETE CASCADE,
    
    -- Report metadata
    report_type VARCHAR(50) NOT NULL,  -- 'annual_report', 'quarterly_report', etc.
    report_date DATE,
    report_title TEXT,
    
    -- Source of truth
    source_url TEXT NOT NULL,
    source_domain VARCHAR(255),
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    source_available BOOLEAN DEFAULT true,
    
    -- GCS backup
    gcs_url TEXT,
    gcs_path TEXT,  -- e.g., 'CBA/2024-annual-report.pdf'
    gcs_synced_at TIMESTAMP WITH TIME ZONE,
    gcs_bucket VARCHAR(255) DEFAULT 'shorted-financial-reports',
    
    -- File metadata
    file_size_bytes BIGINT,
    file_hash VARCHAR(64),  -- SHA256
    mime_type VARCHAR(100) DEFAULT 'application/pdf',
    
    -- Sync status
    sync_status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'downloading', 'uploaded', 'failed'
    sync_error TEXT,
    sync_attempts INTEGER DEFAULT 0,
    
    -- Source tracking
    crawler_source VARCHAR(50),  -- 'smart_crawler', 'asx_api', 'manual', etc.
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    UNIQUE(stock_code, source_url),
    UNIQUE(stock_code, gcs_path)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_financial_reports_stock_code ON financial_report_files(stock_code);
CREATE INDEX IF NOT EXISTS idx_financial_reports_type ON financial_report_files(report_type);
CREATE INDEX IF NOT EXISTS idx_financial_reports_sync_status ON financial_report_files(sync_status);
CREATE INDEX IF NOT EXISTS idx_financial_reports_date ON financial_report_files(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_financial_reports_source_url_hash ON financial_report_files USING HASH(source_url);

-- Comments
COMMENT ON TABLE financial_report_files IS 'Tracking table for financial report PDFs with both source URLs and GCS backups';
COMMENT ON COLUMN financial_report_files.source_url IS 'Original URL (source of truth) - external website';
COMMENT ON COLUMN financial_report_files.gcs_url IS 'Google Cloud Storage backup URL - our reliable copy';
COMMENT ON COLUMN financial_report_files.file_hash IS 'SHA256 hash for file integrity verification';

-- Create view for reports needing sync
CREATE OR REPLACE VIEW reports_needing_sync AS
SELECT 
    stock_code,
    report_type,
    report_title,
    source_url,
    sync_status,
    sync_attempts,
    created_at
FROM financial_report_files
WHERE sync_status IN ('pending', 'failed')
  AND sync_attempts < 3
  AND source_available = true
ORDER BY created_at DESC;

-- Create view for successfully synced reports
CREATE OR REPLACE VIEW synced_reports AS
SELECT 
    f.stock_code,
    m.company_name,
    f.report_type,
    f.report_title,
    f.report_date,
    f.source_url,
    f.gcs_url,
    f.file_size_bytes / 1024.0 / 1024.0 as file_size_mb,
    f.gcs_synced_at,
    f.crawler_source
FROM financial_report_files f
JOIN "company-metadata" m ON f.stock_code = m.stock_code
WHERE f.sync_status = 'uploaded'
  AND f.gcs_url IS NOT NULL
ORDER BY f.gcs_synced_at DESC;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_financial_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_reports_updated_at_trigger
    BEFORE UPDATE ON financial_report_files
    FOR EACH ROW
    EXECUTE FUNCTION update_financial_reports_updated_at();

-- Example queries:

-- Get all reports for a company with sync status:
-- SELECT * FROM financial_report_files WHERE stock_code = 'CBA' ORDER BY report_date DESC;

-- Get companies with most reports:
-- SELECT stock_code, COUNT(*) as report_count 
-- FROM financial_report_files 
-- WHERE sync_status = 'uploaded' 
-- GROUP BY stock_code 
-- ORDER BY report_count DESC;

-- Get sync statistics:
-- SELECT 
--     sync_status,
--     COUNT(*) as count,
--     ROUND(AVG(file_size_bytes / 1024.0 / 1024.0), 2) as avg_size_mb
-- FROM financial_report_files
-- GROUP BY sync_status;

