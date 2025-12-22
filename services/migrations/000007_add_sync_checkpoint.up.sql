-- Add checkpoint tracking to sync_status table for resumable batch processing

-- Add checkpoint columns to sync_status
ALTER TABLE sync_status
ADD COLUMN IF NOT EXISTS checkpoint_stocks_processed TEXT[],  -- Array of stock codes that have been processed
ADD COLUMN IF NOT EXISTS checkpoint_stocks_total INTEGER,     -- Total stocks to process
ADD COLUMN IF NOT EXISTS checkpoint_stocks_successful TEXT[], -- Array of successfully updated stock codes
ADD COLUMN IF NOT EXISTS checkpoint_stocks_failed TEXT[],     -- Array of failed stock codes
ADD COLUMN IF NOT EXISTS checkpoint_batch_size INTEGER DEFAULT 500, -- Stocks per batch
ADD COLUMN IF NOT EXISTS checkpoint_resume_from INTEGER DEFAULT 0;  -- Index to resume from

-- Create index for finding incomplete syncs
CREATE INDEX IF NOT EXISTS idx_sync_status_checkpoint 
ON sync_status (status, started_at DESC) 
WHERE status IN ('running', 'partial');

-- Create table to track daily sync progress per stock
CREATE TABLE IF NOT EXISTS daily_sync_progress (
    id SERIAL PRIMARY KEY,
    sync_date DATE NOT NULL DEFAULT CURRENT_DATE,
    stock_code VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    run_id UUID,  -- Link to sync_status.run_id
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    records_updated INTEGER DEFAULT 0,
    source VARCHAR(20), -- 'alpha_vantage', 'yahoo', 'none'
    UNIQUE(sync_date, stock_code)
);

-- Index for querying progress
CREATE INDEX IF NOT EXISTS idx_daily_sync_progress_date_status 
ON daily_sync_progress (sync_date DESC, status);

CREATE INDEX IF NOT EXISTS idx_daily_sync_progress_run_id 
ON daily_sync_progress (run_id);

-- Comment
COMMENT ON TABLE daily_sync_progress IS 'Tracks individual stock sync progress for daily batch processing';
COMMENT ON COLUMN sync_status.checkpoint_stocks_processed IS 'Array of stock codes processed in this run';
COMMENT ON COLUMN sync_status.checkpoint_stocks_total IS 'Total number of stocks to process';
COMMENT ON COLUMN sync_status.checkpoint_stocks_successful IS 'Array of stock codes successfully updated';
COMMENT ON COLUMN sync_status.checkpoint_stocks_failed IS 'Array of stock codes that failed';
COMMENT ON COLUMN sync_status.checkpoint_batch_size IS 'Number of stocks to process per batch';
COMMENT ON COLUMN sync_status.checkpoint_resume_from IS 'Index in stock list to resume from on retry';

