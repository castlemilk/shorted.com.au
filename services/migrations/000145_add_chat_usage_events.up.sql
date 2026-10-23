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
-- 'pending' row is what makes an in-flight send count. A send that rejects
-- is updated to 'limited', which no count includes. A send whose instance dies
-- mid-turn stays 'pending', and so keeps counting: it did reach the model.
--
-- IDEMPOTENCY IS MANDATORY, NOT DEFENSIVE STYLE
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml
-- applies a hardcoded `-f /migrations/...` allowlist and RE-RUNS IT ON EVERY
-- DEPLOY. Every statement below is therefore re-runnable and touches no row.
-- `CREATE TABLE IF NOT EXISTS` skips the whole definition, including the
-- inline CHECK, once the table exists, so the constraint is never re-added.

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

    -- 'pending' is the in-flight state described above and is counted, as are
    -- 'ok', 'error' and 'canceled' (each of which reached the model). 'limited'
    -- means the send was rejected before the model and is never counted.
    outcome TEXT NOT NULL
        CHECK (outcome IN ('pending', 'ok', 'error', 'limited', 'canceled')),

    -- NULL when the provider reported no usage, for example when the stream
    -- was canceled before its final usage chunk arrived.
    input_tokens INT,
    output_tokens INT,

    tool_calls INT NOT NULL DEFAULT 0,

    model TEXT
);

-- The per-user windows (minute, day, month) scan this index.
CREATE INDEX IF NOT EXISTS idx_chat_usage_events_user_created
    ON chat_usage_events (user_id, created_at DESC);

-- The global per-minute ceiling scans across all users by time alone.
CREATE INDEX IF NOT EXISTS idx_chat_usage_events_created
    ON chat_usage_events (created_at);

COMMENT ON TABLE chat_usage_events IS
    'One row per chat send: pending while the model runs, then ok|error|canceled, or limited when rejected. Written and counted by services/chat-service (chat_limits.go). Not a billing ledger: a send whose instance died stays pending and still counts against the limits.';
