-- Add priority tracking columns to sync_status for prioritized stock syncing
-- This allows tracking of high-priority (top shorted) stocks separately

-- Add integer count columns if they don't exist (some installations may have TEXT[] versions)
DO $$
BEGIN
    -- Add checkpoint_stocks_processed as INTEGER if it doesn't exist or is wrong type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sync_status' 
        AND column_name = 'checkpoint_stocks_processed' 
        AND data_type = 'integer'
    ) THEN
        -- Try to add or alter
        BEGIN
            ALTER TABLE sync_status ADD COLUMN checkpoint_stocks_processed INTEGER DEFAULT 0;
        EXCEPTION WHEN duplicate_column THEN
            -- Column exists but might be wrong type, try to alter
            ALTER TABLE sync_status ALTER COLUMN checkpoint_stocks_processed TYPE INTEGER USING 0;
        END;
    END IF;

    -- Add checkpoint_stocks_successful as INTEGER
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sync_status' 
        AND column_name = 'checkpoint_stocks_successful' 
        AND data_type = 'integer'
    ) THEN
        BEGIN
            ALTER TABLE sync_status ADD COLUMN checkpoint_stocks_successful INTEGER DEFAULT 0;
        EXCEPTION WHEN duplicate_column THEN
            ALTER TABLE sync_status ALTER COLUMN checkpoint_stocks_successful TYPE INTEGER USING 0;
        END;
    END IF;

    -- Add checkpoint_stocks_failed as INTEGER
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sync_status' 
        AND column_name = 'checkpoint_stocks_failed' 
        AND data_type = 'integer'
    ) THEN
        BEGIN
            ALTER TABLE sync_status ADD COLUMN checkpoint_stocks_failed INTEGER DEFAULT 0;
        EXCEPTION WHEN duplicate_column THEN
            ALTER TABLE sync_status ALTER COLUMN checkpoint_stocks_failed TYPE INTEGER USING 0;
        END;
    END IF;
END $$;

-- Add priority tracking columns
ALTER TABLE sync_status
    ADD COLUMN IF NOT EXISTS checkpoint_priority_total INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS checkpoint_priority_processed INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS checkpoint_priority_completed BOOLEAN DEFAULT FALSE;

-- Add index for faster checkpoint queries on running syncs
CREATE INDEX IF NOT EXISTS idx_sync_status_running
    ON sync_status(status) WHERE status = 'running';

-- Add comments
COMMENT ON COLUMN sync_status.checkpoint_priority_total IS 'Number of priority (top shorted) stocks to sync first';
COMMENT ON COLUMN sync_status.checkpoint_priority_processed IS 'Number of priority stocks processed so far';
COMMENT ON COLUMN sync_status.checkpoint_priority_completed IS 'Whether all priority stocks have been processed';
