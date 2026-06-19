-- 000050_director_trades_dedup
--
-- director_trades had no natural-key constraint (only a uuid PK), so the
-- crawler's `INSERT ... ON CONFLICT DO NOTHING` never deduped — every re-crawl
-- re-inserted identical rows. Result: ~4.8M rows / ~1.2 GB, almost all
-- duplicates (it's the single biggest table). This (1) collapses each
-- natural-key group to its earliest row, then (2) adds a UNIQUE index so future
-- ON CONFLICT DO NOTHING actually dedups.
--
-- PROD: apply with `SET statement_timeout = 0;` — the dedup DELETE over 4.8M
-- rows is heavy. Afterwards run `VACUUM (ANALYZE) director_trades;` to reclaim
-- the freed space and refresh stats.

-- 1. Remove duplicates, keeping the earliest-created row per natural key.
DELETE FROM director_trades d
USING (
    SELECT id,
           row_number() OVER (
               PARTITION BY stock_code, director_name, trade_date, trade_type,
                            shares_traded, COALESCE(announcement_url, '')
               ORDER BY created_at NULLS LAST, id
           ) AS rn
    FROM director_trades
) dup
WHERE d.id = dup.id
  AND dup.rn > 1;

-- 2. Enforce uniqueness so re-crawls dedup via ON CONFLICT DO NOTHING.
--    COALESCE(announcement_url,'') so rows with a NULL/empty url still dedup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_director_trades_natural
    ON director_trades (
        stock_code, director_name, trade_date, trade_type,
        shares_traded, COALESCE(announcement_url, '')
    );
