ALTER TABLE sync_status ADD COLUMN IF NOT EXISTS checkpoint_stocks_skipped INTEGER DEFAULT 0;
