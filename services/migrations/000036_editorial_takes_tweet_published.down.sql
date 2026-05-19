DROP INDEX IF EXISTS idx_editorial_takes_tweet_queue;
ALTER TABLE editorial_takes DROP COLUMN IF EXISTS tweet_published_at;
