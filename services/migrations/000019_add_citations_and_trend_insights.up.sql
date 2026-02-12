ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS citations JSONB;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS trend_insights JSONB;
