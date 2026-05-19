-- Tweet publish tracking. The bot's process-publish-queue picks rows
-- where published_at IS NOT NULL AND tweet_published_at IS NULL, posts
-- to X, then sets tweet_published_at. Decouples the web publish
-- action from the bot cron without needing webhooks.

ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS tweet_published_at TIMESTAMPTZ;

-- The publish-queue worker uses this to find work.
CREATE INDEX IF NOT EXISTS idx_editorial_takes_tweet_queue
  ON editorial_takes (published_at)
  WHERE published_at IS NOT NULL AND tweet_published_at IS NULL;
