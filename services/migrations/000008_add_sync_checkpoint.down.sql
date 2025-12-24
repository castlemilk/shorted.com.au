-- Rollback checkpoint tracking

DROP TABLE IF EXISTS daily_sync_progress;
DROP INDEX IF EXISTS idx_sync_status_checkpoint;

ALTER TABLE sync_status
DROP COLUMN IF EXISTS checkpoint_stocks_processed,
DROP COLUMN IF EXISTS checkpoint_stocks_total,
DROP COLUMN IF EXISTS checkpoint_stocks_successful,
DROP COLUMN IF EXISTS checkpoint_stocks_failed,
DROP COLUMN IF EXISTS checkpoint_batch_size,
DROP COLUMN IF EXISTS checkpoint_resume_from;



