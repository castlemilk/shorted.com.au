-- Track symbols that consistently fail Yahoo Finance fetches
-- so we can auto-skip them and avoid wasting hours on 404s
CREATE TABLE IF NOT EXISTS stock_sync_failures (
    stock_code VARCHAR(20) PRIMARY KEY,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_failure_at TIMESTAMPTZ,
    last_error TEXT,
    blocked_until TIMESTAMPTZ,  -- NULL = not blocked, future date = blocked until then
    last_success_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_sync_failures_blocked ON stock_sync_failures (blocked_until)
    WHERE blocked_until IS NOT NULL;
