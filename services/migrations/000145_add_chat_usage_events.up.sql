-- Per-send usage ledger for the paid AI chat, read and written by
-- services/chat-service to enforce the per-user and global send limits.
--
-- WHY THIS TABLE EXISTS
--
-- The web app enforced chat limits in Redis, and fails closed in production.
-- A Redis outage therefore 503'd every paying user. The chat service had no
-- limit of its own at all: its only gate is the shared internal secret, so a
-- leaked secret meant unbounded Gemini spend. This table is the authoritative
-- record the chat service counts against. The web buckets remain a first line.
--
-- ONE ROW PER SEND, WRITTEN IN TWO STEPS
--
-- A row is inserted as 'pending' before the model is called, and updated once
-- the turn ends. Counting at the start of a send alone is not enough: a burst
-- of parallel sends would all see zero, because none has finished yet. The
-- 'pending' row is what makes an in-flight send count.
--
-- Outcomes that count against the limits: pending, ok, error, canceled. The
-- model was reached. Outcomes that do not: limited (refused by the limiter) and
-- failed_before_model (the turn failed before the provider answered, so nothing
-- was billed).
--
-- IDEMPOTENCY IS MANDATORY, NOT DEFENSIVE STYLE
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml
-- applies a hardcoded `-f /migrations/...` allowlist and RE-RUNS IT ON EVERY
-- DEPLOY. Every statement below is therefore re-runnable and touches no row.
--
-- REPLAY MUST NOT WAIT ON THE WRITER
--
-- CREATE INDEX IF NOT EXISTS takes a SHARE lock on the table before it checks
-- the name, so a replay queued behind every in-flight chat insert and held the
-- inserts up behind it. Measured on Postgres 15: a replay waited 5 seconds
-- behind a 6 second insert. Each index is therefore created only when the
-- catalog lacks it, and the whole file runs under lock_timeout, as 000136 does.
-- A replay that changes nothing takes no lock on chat_usage_events at all.
--
-- The one case that changes an existing definition is the outcome CHECK, when
-- an earlier version of this table is present. It is widened once, under the
-- same guard. No environment has an earlier version.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS chat_usage_events (
    id BIGSERIAL PRIMARY KEY,

    -- The Firebase uid the chat service was told the caller is (X-User-Id).
    -- TEXT, matching chat_conversations.user_id's meaning rather than its
    -- VARCHAR(255) width, so no uid is ever refused at the limiter.
    user_id TEXT NOT NULL,

    -- The conversation the send landed in. NULL while a send is pending or
    -- limited, and for a first send that never created a conversation. Not a
    -- foreign key: usage is a ledger, so it must outlive a deleted conversation.
    conversation_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- See the header for which outcomes count against the limits.
    outcome TEXT NOT NULL,
    CONSTRAINT chat_usage_events_outcome_check
        CHECK (outcome IN ('pending', 'ok', 'error', 'limited', 'canceled', 'failed_before_model')),

    -- NULL when the provider reported no usage, for example when the stream
    -- was canceled before its final usage chunk arrived.
    input_tokens INT,
    output_tokens INT,

    tool_calls INT NOT NULL DEFAULT 0,

    model TEXT
);

-- Widen the outcome CHECK when an earlier version of this table is in place.
-- Read the current definition first, so a replay that finds the new one changes
-- nothing and takes no lock beyond the catalog read.
DO $m145_check$
DECLARE
    definition TEXT;
BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO definition
      FROM pg_constraint c
     WHERE c.conrelid = to_regclass('chat_usage_events')
       AND c.conname = 'chat_usage_events_outcome_check';

    IF definition IS NOT NULL AND definition NOT LIKE '%failed_before_model%' THEN
        ALTER TABLE chat_usage_events DROP CONSTRAINT chat_usage_events_outcome_check;
        ALTER TABLE chat_usage_events ADD CONSTRAINT chat_usage_events_outcome_check
            CHECK (outcome IN ('pending', 'ok', 'error', 'limited', 'canceled', 'failed_before_model'));
    END IF;
END
$m145_check$;

-- The per-user windows (minute, day, month) scan this index. Created only when
-- the catalog lacks it: to_regclass is a catalog read that takes no table lock.
DO $m145_idx_user$
BEGIN
    IF to_regclass('idx_chat_usage_events_user_created') IS NULL THEN
        EXECUTE 'CREATE INDEX idx_chat_usage_events_user_created ON chat_usage_events (user_id, created_at DESC)';
    END IF;
END
$m145_idx_user$;

-- The global per-minute ceiling scans across all users by time alone.
DO $m145_idx_created$
BEGIN
    IF to_regclass('idx_chat_usage_events_created') IS NULL THEN
        EXECUTE 'CREATE INDEX idx_chat_usage_events_created ON chat_usage_events (created_at)';
    END IF;
END
$m145_idx_created$;

-- The comment is rewritten only when its text differs, for the same reason.
DO $m145_comment$
DECLARE
    note CONSTANT TEXT := 'One row per chat send: pending while the model runs, then ok, error or canceled once it has. Refused sends are limited; turns that fail before the provider answers are failed_before_model. Written and counted by services/chat-service (chat_limits.go). Not a billing ledger: a send whose instance died stays pending and still counts against the limits.';
BEGIN
    IF obj_description('chat_usage_events'::regclass, 'pg_class') IS DISTINCT FROM note THEN
        EXECUTE format('COMMENT ON TABLE chat_usage_events IS %L', note);
    END IF;
END
$m145_comment$;

COMMIT;
