-- Monthly API quota accounting, moved off Upstash and onto Postgres.
--
-- WHY THIS TABLE EXISTS
--
-- The August 2026 incident was a shared-quota failure, not a rate-limiting
-- failure: the app-layer limiter ran a 7-command Upstash pipeline per request
-- against the SAME Upstash database that backs the page cache. Exhausting the
-- command cap took down both tenants at once. PR #455 cut the command volume
-- ~87x, but the two products still shared one dependency and one quota.
--
-- This moves quota accounting to Postgres, which the API already has a pool
-- for, and which has no per-command billing cap to exhaust. After this, the
-- rate-limit path touches Upstash ZERO times; Upstash remains the page cache's
-- alone.
--
-- WHY IT IS SAFE TO PUT ON THE PRIMARY DB
--
-- The limiter never reads or writes on the request path. Increments accumulate
-- in memory and are flushed as ONE multi-row upsert covering every pending
-- identifier, at most every 5 minutes per instance. Measured shape: a few
-- hundred statements per day, against a table with one row per
-- (identifier, month). This is orders of magnitude below the traffic the MV
-- refreshes already impose.
--
-- IDEMPOTENCY IS MANDATORY, NOT DEFENSIVE STYLE
--
-- Prod does NOT run `migrate up`. .github/workflows/terraform-deploy.yml
-- applies a hardcoded `-f /migrations/...` allowlist and RE-RUNS IT ON EVERY
-- DEPLOY. This file is in that allowlist, so it executes several times a week
-- against a live table holding real quota counters. Every statement below must
-- therefore be re-runnable and must never touch existing rows.

CREATE TABLE IF NOT EXISTS api_usage_monthly (
    -- Rate-limit identifier, as produced by extractIdentifierAndTier:
    -- "user:<uid>" for authenticated callers, "ip:<addr>" for anonymous ones
    -- (anonymous is unmetered by default, so in practice this is user-keyed).
    identifier TEXT NOT NULL,

    -- First day of the quota month (UTC-normalised by the caller). A DATE
    -- rather than a text "2006-01" so month arithmetic and retention pruning
    -- are ordinary date operations.
    period_month DATE NOT NULL,

    request_count BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The upsert target. Without this the flush's ON CONFLICT has nothing to
    -- resolve against and every flush would append duplicate rows.
    PRIMARY KEY (identifier, period_month)
);

-- Retention/reporting sweeps scan by month, not by identifier, and the primary
-- key is identifier-major so it cannot serve them.
CREATE INDEX IF NOT EXISTS idx_api_usage_monthly_period
    ON api_usage_monthly (period_month);

COMMENT ON TABLE api_usage_monthly IS
    'Monthly API request counts per rate-limit identifier. Written by services/pkg/ratelimit (batched, eventually consistent — see monthly.go for the overshoot bound). Not a billing ledger: counts may undercount by up to one flush batch per instance.';

COMMENT ON COLUMN api_usage_monthly.request_count IS
    'Cumulative requests this month. Advanced by additive upserts only; never assigned a computed value, so concurrent instances converge instead of clobbering.';
