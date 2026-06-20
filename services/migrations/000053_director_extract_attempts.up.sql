-- §6.9 Failure-budget for the scheduled director-trade extractor.
--
-- extract_director_trades.py selects rows where extraction hasn't succeeded
-- (director_name='Unknown Director' OR total_value IS NULL). Many Appendix 3Y PDFs
-- never extract (older/expired ASX URLs, scanned PDFs), so without a marker the daily
-- job re-attempts the same persistent failures every run, burning Gemini quota and never
-- draining the queue. This table records each attempt so failed URLs are skipped for a
-- cool-off window (--retry-after-days) while still allowing eventual re-tries (e.g. once
-- §6.4 re-resolves 2024 URLs).
CREATE TABLE IF NOT EXISTS director_extract_attempts (
    announcement_url  TEXT PRIMARY KEY,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_outcome      TEXT,
    last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_director_extract_attempts_last
    ON director_extract_attempts (last_attempted_at);
