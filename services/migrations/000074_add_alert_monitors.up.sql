BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS alert_monitors (
    id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     text NOT NULL,
    user_email  text,
    scope       text NOT NULL,
    target      text NOT NULL,
    condition   text NOT NULL,
    threshold   double precision,
    cadence     text NOT NULL DEFAULT 'daily',
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alert_monitors_scope_check CHECK (scope IN ('industry', 'stock')),
    CONSTRAINT alert_monitors_condition_check CHECK (condition IN ('short_interest_above', 'short_interest_rises', 'new_top_ten_entry')),
    CONSTRAINT alert_monitors_cadence_check CHECK (cadence IN ('daily', 'weekly')),
    CONSTRAINT alert_monitors_status_check CHECK (status IN ('active', 'paused')),
    CONSTRAINT alert_monitors_target_not_blank CHECK (length(btrim(target)) > 0),
    CONSTRAINT alert_monitors_stock_target_upper_check CHECK (scope != 'stock' OR target = upper(target)),
    CONSTRAINT alert_monitors_threshold_check CHECK (threshold IS NULL OR (threshold >= 0 AND threshold <= 100))
);

CREATE INDEX IF NOT EXISTS idx_alert_monitors_user_created
  ON alert_monitors (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_alert_monitors_user_status_created
  ON alert_monitors (user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_alert_monitors_user_scope_target
  ON alert_monitors (user_id, scope, target);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_monitors_active_unique
  ON alert_monitors (user_id, scope, target, condition, cadence, COALESCE(threshold, (-1)::double precision))
  WHERE status = 'active';

DROP TRIGGER IF EXISTS update_alert_monitors_updated_at ON alert_monitors;
CREATE TRIGGER update_alert_monitors_updated_at
    BEFORE UPDATE ON alert_monitors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
