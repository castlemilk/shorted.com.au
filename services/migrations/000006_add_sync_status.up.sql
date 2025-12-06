-- Add sync_status table to track daily sync runs
-- This provides observability into sync job health

CREATE TABLE IF NOT EXISTS sync_status (
    id SERIAL PRIMARY KEY,
    
    -- Run identification
    run_id UUID DEFAULT gen_random_uuid(),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Overall status
    status VARCHAR(20) NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed'
    error_message TEXT,
    
    -- Shorts sync metrics
    shorts_records_updated INTEGER DEFAULT 0,
    shorts_status VARCHAR(20) DEFAULT 'pending',
    shorts_duration_seconds NUMERIC(10, 2),
    
    -- Stock prices sync metrics  
    prices_records_updated INTEGER DEFAULT 0,
    prices_alpha_success INTEGER DEFAULT 0,
    prices_yahoo_success INTEGER DEFAULT 0,
    prices_failed INTEGER DEFAULT 0,
    prices_skipped INTEGER DEFAULT 0,
    prices_status VARCHAR(20) DEFAULT 'pending',
    prices_duration_seconds NUMERIC(10, 2),
    
    -- Key metrics sync metrics
    metrics_records_updated INTEGER DEFAULT 0,
    metrics_failed INTEGER DEFAULT 0,
    metrics_status VARCHAR(20) DEFAULT 'pending',
    metrics_duration_seconds NUMERIC(10, 2),
    
    -- Algolia sync metrics
    algolia_status VARCHAR(20) DEFAULT 'pending',
    algolia_records_synced INTEGER DEFAULT 0,
    
    -- Total duration
    total_duration_seconds NUMERIC(10, 2),
    
    -- Environment info
    environment VARCHAR(50),
    hostname VARCHAR(255),
    
    -- Constraints
    CHECK (status IN ('running', 'completed', 'failed', 'partial'))
);

-- Index for querying recent runs
CREATE INDEX IF NOT EXISTS idx_sync_status_started_at 
ON sync_status (started_at DESC);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_sync_status_status 
ON sync_status (status);

-- Comment
COMMENT ON TABLE sync_status IS 'Audit table tracking each daily sync run and its metrics';

-- Helper view for monitoring
CREATE OR REPLACE VIEW sync_status_summary AS
SELECT 
    DATE(started_at) as sync_date,
    status,
    shorts_records_updated,
    prices_records_updated,
    metrics_records_updated,
    total_duration_seconds,
    CASE 
        WHEN status = 'failed' THEN error_message 
        ELSE NULL 
    END as error
FROM sync_status
ORDER BY started_at DESC
LIMIT 30;

COMMENT ON VIEW sync_status_summary IS 'Summary view of recent sync runs for monitoring';

