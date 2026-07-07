BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS community_threads (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    stock_code          text NOT NULL CHECK (stock_code = upper(stock_code)),
    type                text NOT NULL CHECK (type IN ('bull', 'bear', 'catalyst', 'question', 'news_reaction')),
    title               text NOT NULL,
    body                text NOT NULL,
    score               integer NOT NULL DEFAULT 0,
    comment_count       integer NOT NULL DEFAULT 0,
    source_count        integer NOT NULL DEFAULT 0,
    high_signal         boolean NOT NULL DEFAULT false,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'deleted', 'needs_review')),
    author_user_id      text,
    author_display_name text,
    author_handle       text,
    author_avatar_url   text,
    author_trust_score  numeric,
    sources             jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_activity_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_comments (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    stock_code          text NOT NULL CHECK (stock_code = upper(stock_code)),
    thread_id           text NOT NULL REFERENCES community_threads(id) ON DELETE CASCADE,
    body                text NOT NULL,
    score               integer NOT NULL DEFAULT 0,
    reply_count         integer NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'deleted', 'needs_review')),
    author_user_id      text,
    author_display_name text,
    author_handle       text,
    author_avatar_url   text,
    author_trust_score  numeric,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_pulse (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    stock_code          text NOT NULL CHECK (stock_code = upper(stock_code)),
    body                text NOT NULL,
    score               integer NOT NULL DEFAULT 0,
    reply_count         integer NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'deleted', 'needs_review')),
    author_user_id      text,
    author_display_name text,
    author_handle       text,
    author_avatar_url   text,
    author_trust_score  numeric,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_pulse_replies (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    stock_code          text NOT NULL CHECK (stock_code = upper(stock_code)),
    pulse_id            text NOT NULL REFERENCES community_pulse(id) ON DELETE CASCADE,
    body                text NOT NULL,
    score               integer NOT NULL DEFAULT 0,
    reply_count         integer NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'deleted', 'needs_review')),
    author_user_id      text,
    author_display_name text,
    author_handle       text,
    author_avatar_url   text,
    author_trust_score  numeric,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_votes (
    id          text PRIMARY KEY,
    stock_code  text NOT NULL CHECK (stock_code = upper(stock_code)),
    target_type text NOT NULL CHECK (target_type IN ('thread', 'comment', 'pulse', 'pulse_reply')),
    target_id   text NOT NULL,
    value       smallint NOT NULL CHECK (value IN (-1, 1)),
    user_id     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS community_reports (
    id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    stock_code  text NOT NULL CHECK (stock_code = upper(stock_code)),
    target_type text NOT NULL CHECK (target_type IN ('thread', 'comment', 'pulse', 'pulse_reply')),
    target_id   text NOT NULL,
    reason      text NOT NULL,
    details     text,
    user_id     text NOT NULL,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_threads_active_stock_activity
  ON community_threads (stock_code, last_activity_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_community_pulse_active_stock_created
  ON community_pulse (stock_code, created_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_community_comments_active_thread_created
  ON community_comments (thread_id, created_at ASC, id ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_community_pulse_replies_active_pulse_created
  ON community_pulse_replies (pulse_id, created_at ASC, id ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_community_votes_target
  ON community_votes (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_community_reports_status_created
  ON community_reports (status, created_at DESC);

COMMIT;
