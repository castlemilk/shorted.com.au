-- Mailing-list broadcasts + unsubscribe support.
-- NOTE: written IF NOT EXISTS against the REAL prod subscriptions shape
-- (id uuid, email text) — the committed 000001 schema is drifted, do not trust it.
BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_subscriptions_active
  ON subscriptions (email) WHERE unsubscribed_at IS NULL;

CREATE TABLE IF NOT EXISTS broadcasts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type            text NOT NULL CHECK (type IN ('weekly_report','monthly_report','news_digest')),
    subject         text NOT NULL,
    html_body       text NOT NULL,
    text_body       text NOT NULL DEFAULT '',
    source_ref      text,
    status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
    recipient_count integer NOT NULL DEFAULT 0,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);

-- Idempotency: re-publishing the same report/week must not create a duplicate draft.
CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcasts_type_source
  ON broadcasts (type, source_ref) WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status_created
  ON broadcasts (status, created_at DESC);

COMMIT;
