ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS generation_history JSONB DEFAULT '[]';
