-- Remove priority tracking columns from sync_status

ALTER TABLE sync_status
    DROP COLUMN IF EXISTS checkpoint_priority_total,
    DROP COLUMN IF EXISTS checkpoint_priority_processed,
    DROP COLUMN IF EXISTS checkpoint_priority_completed;

DROP INDEX IF EXISTS idx_sync_status_running;
