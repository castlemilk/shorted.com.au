-- Migration 000130: price-structure features, market regime, and their
-- guarded refresh (stock picker, docs/plans/stock-picker.md §2.3-2.5)
--
-- The strategy evaluator (services/shorts/internal/strategies) scores every
-- ASX stock against rules like "a tight 20-120 session base, then a close
-- above its high on 1.5x volume" and "XJO above its 200-day". Computing those
-- per request over 3.9M stock_prices rows is seconds of window functions; this
-- computes them once per day, after the price sweep, into two small views the
-- API reads by primary key.
--
-- mv_price_features: one row per stock with >= 60 sessions in the last 400
--   calendar days, features over its trailing 260 sessions.
-- mv_market_regime: one row per index_metadata code (XJO is the one used):
--   uptrend when close > sma50 > sma200, neutral when close > sma200, else
--   downtrend; NULL when there is not enough history to know.
-- refresh_strategy_views(): refreshes these two plus mv_fundamentals_growth
--   (000129). A NEW function, deliberately NOT part of
--   refresh_all_materialized_views(): that one runs at 10:00 UTC from the
--   ASIC sync, while the price sweep starts 10:00 UTC and runs ~2.5h, so it
--   would always compute yesterday's prices. `shorted picks -mode refresh`
--   calls this at 13:30 UTC on weekdays, after the sweep.
--
-- SUPABASE-FRIENDLY (work_mem 2MB): nothing here windows over the whole
-- stock_prices table. The only scan is date-bounded (last 400 days, ~650k of
-- 3.9M rows); every window shares ONE partition/order (stock_code, date), so
-- the rows are sorted once; features that are only needed at the latest
-- session are plain FILTERed aggregates over the session rank, not windows;
-- the XJO lookups are index probes into index_prices. Missing or non-finite
-- inputs never produce a value: every average requires its full window
-- (sma200 over 150 sessions is NULL, not a 150-day average), every division is
-- behind a `> 0` CASE, and NaN prices are filtered out (in Postgres NaN
-- compares greater than every number, so `close <= 99999999.99`, the
-- DECIMAL(10,2) maximum, excludes it).
--
-- THE BASE (base_high / base_low / base_depth_pct / base_length_days) is
-- described as at an anchor session: the earliest breakout of the last five
-- sessions when there is one, else as_of. Otherwise the pivot moves the day
-- after a breakout (the breakout's own high enters the prior-40 window) and
-- base_high, which the API serves as the invalidation level, stops being the
-- level the stock cleared. base_length_days counts back to the EARLIEST
-- session in that 40-session window whose high is within 2% of base_high, so
-- a flat base counts its full length rather than 1 (an exact retest of the
-- high is common with prices stored to 2 decimals). Both found by the API
-- stream on a scratch Postgres 16, before any environment applied 000130.
--
-- The guarded refresh is 000095's pattern verbatim: every REFRESH in its own
-- BEGIN/EXCEPTION block, CONCURRENTLY first, a plain refresh as fallback, and
-- handlers that name `query_canceled` explicitly (plpgsql's WHEN OTHERS does
-- NOT match 57014, which is what a statement_timeout raises), so one failing
-- view is a WARNING 'Skipping <view>: ...' and never starves the next. The
-- job's refresh treats any 'Skipping' warning as a failed run, the way
-- `task db:prod:refresh` does. Cheapest view first.
--
-- REPLAY-SAFE: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION, ALTER
-- FUNCTION ... SET and COMMENT only; no row is read or written by DDL, and no
-- view is dropped, so a replay never rebuilds anything. This is safe in the
-- deploy allowlist, which re-runs it on every deploy. It sits AFTER 000095 in
-- that list: it does not touch refresh_all_materialized_views(), but any
-- migration that defines a refresh function goes after the hardening. A later
-- change to a view definition needs a NEW, hand-applied migration.
--
-- Hand-apply BEFORE merging the API that reads it (plan §7): session pooler
-- 5432, `task db:prod:apply FILE=... CONFIRM=prod`. Building mv_price_features
-- the first time is a full pass over the last 400 days of prices, which is why
-- the file disarms the timeout in-session inside its own transaction.

-- LOCK ORDER. On a replay, CREATE UNIQUE INDEX IF NOT EXISTS takes a SHARE
-- lock on its view BEFORE it notices the index exists, and holds it to COMMIT.
-- refresh_strategy_views() takes EXCLUSIVE locks in the order mv_market_regime
-- -> mv_fundamentals_growth -> mv_price_features, all held to the end of its
-- call. So this file touches the views in that same order (regime, then price
-- features; 000129's own transaction has already committed): a deploy that
-- overlaps the 13:30 UTC refresh waits for it instead of deadlocking with it.

BEGIN;

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1. mv_market_regime: one row per index_metadata code. An index with no (or
--    too little) price history still gets its row, with NULLs and a NULL
--    regime, so "unknown" is visible rather than silently missing.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_market_regime AS
WITH ix AS (
    SELECT ip.index_code,
           ip.date,
           ip.close,
           GREATEST(CASE WHEN ip.high > 0 AND ip.high < 'Infinity'::float8 THEN ip.high END,
                    ip.close) AS high
    FROM index_prices ip
    WHERE ip.date >= CURRENT_DATE - 400
      AND ip.date <= CURRENT_DATE
      AND ip.close > 0
      AND ip.close < 'Infinity'::float8
),
seq AS (
    SELECT ix.index_code, ix.date, ix.close, ix.high,
           count(*)             OVER wp AS n_sessions,
           row_number()         OVER w  AS rn_asc,
           max(ix.date)         OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '1 month'  PRECEDING) AS d1m,
           last_value(ix.close) OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '1 month'  PRECEDING) AS c1m,
           max(ix.date)         OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '3 months' PRECEDING) AS d3m,
           last_value(ix.close) OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '3 months' PRECEDING) AS c3m
    FROM ix
    WINDOW wp AS (PARTITION BY ix.index_code),
           w  AS (PARTITION BY ix.index_code ORDER BY ix.date)
),
agg AS (
    SELECT s.index_code,
           max(s.date)                                                        AS as_of,
           max(s.close) FILTER (WHERE s.n_sessions - s.rn_asc + 1 = 1)        AS close,
           CASE WHEN count(*) FILTER (WHERE s.n_sessions - s.rn_asc + 1 <= 50) = 50
                THEN avg(s.close) FILTER (WHERE s.n_sessions - s.rn_asc + 1 <= 50) END  AS sma50,
           CASE WHEN count(*) FILTER (WHERE s.n_sessions - s.rn_asc + 1 <= 200) = 200
                THEN avg(s.close) FILTER (WHERE s.n_sessions - s.rn_asc + 1 <= 200) END AS sma200,
           max(s.high)  FILTER (WHERE s.n_sessions - s.rn_asc + 1 <= 252)     AS high_52w,
           max(s.d1m)   FILTER (WHERE s.n_sessions - s.rn_asc + 1 = 1)        AS d1m,
           max(s.c1m)   FILTER (WHERE s.n_sessions - s.rn_asc + 1 = 1)        AS c1m,
           max(s.d3m)   FILTER (WHERE s.n_sessions - s.rn_asc + 1 = 1)        AS d3m,
           max(s.c3m)   FILTER (WHERE s.n_sessions - s.rn_asc + 1 = 1)        AS c3m
    FROM seq s
    GROUP BY s.index_code
)
SELECT
    m.index_code,
    a.as_of,
    a.close,
    a.sma50,
    a.sma200,
    CASE WHEN a.high_52w > 0 THEN LEAST(0, (a.close - a.high_52w) / a.high_52w * 100) END AS pct_off_52w_high,
    CASE WHEN a.c1m > 0 AND a.d1m >= (a.as_of - INTERVAL '1 month'  - INTERVAL '10 days')::date
         THEN (a.close / a.c1m - 1) * 100 END                                           AS ret_1m_pct,
    CASE WHEN a.c3m > 0 AND a.d3m >= (a.as_of - INTERVAL '3 months' - INTERVAL '10 days')::date
         THEN (a.close / a.c3m - 1) * 100 END                                           AS ret_3m_pct,
    (CASE WHEN a.close IS NULL OR a.sma50 IS NULL OR a.sma200 IS NULL THEN NULL
          WHEN a.close > a.sma50 AND a.sma50 > a.sma200 THEN 'uptrend'
          WHEN a.close > a.sma200 THEN 'neutral'
          ELSE 'downtrend'
     END)::varchar(16)                                                                  AS regime
FROM index_metadata m
LEFT JOIN agg a ON a.index_code = m.index_code
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_market_regime_index_code
    ON mv_market_regime (index_code);

COMMENT ON MATERIALIZED VIEW mv_market_regime IS
    'One row per index_metadata code: close, sma50, sma200, distance from the 52w high, 1m/3m returns and regime (uptrend: close > sma50 > sma200; neutral: close > sma200; else downtrend; NULL without 200 sessions). Refreshed by refresh_strategy_views().';

-- ---------------------------------------------------------------------------
-- 2. mv_price_features
--
-- Session rank: rn = 1 is the latest session (as_of), rn = 2 the one before.
--   sma<N>           avg(close) over rn 1..N, only when all N sessions exist
--   sma200_1m_ago    sma200 as of 21 sessions ago (rn 22..221)
--   high_52w/low_52w max(high)/min(low) over rn 1..252
--   avg_volume_50d   avg(volume) over the 50 sessions BEFORE as_of (rn 2..51),
--                    so a breakout's own volume does not inflate its baseline;
--                    NULL with fewer than 20 of them
--   volume_ratio_50d volume(as_of) / avg_volume_50d
--   dollar_volume_20d avg(close * volume) over rn 1..20 (>= 10 sessions)
--   breakout_recent  any of rn 1..5 closed above ITS OWN prior-40-session high
--                    with volume >= 1.5 x ITS OWN prior-50-session average;
--                    breakout_date is the most recent such session
--   The BASE is described as at an anchor session t:
--     t = the EARLIEST breakout session in rn 1..5 when breakout_recent,
--         else as_of (rn 1).
--   Anchoring is what keeps the pivot still. From the day after a breakout
--   the plain [as_of-40, as_of-1] window contains the breakout's own high, so
--   the "pivot" would jump to that (measured on a scratch PG16: 10.30 reported
--   against a real pivot of 9.80) and the invalidation level the API shows
--   would be meaningless. The earliest breakout, not the latest, because on
--   consecutive breakout days the later ones only clear the first day's high,
--   not the base.
--   base_high/low    max(high)/min(low) over sessions [t-40, t-1] (the pivot:
--                    the level the breakout cleared, or will have to clear),
--                    only with all 40 sessions
--   base_length_days sessions elapsed since the EARLIEST session in
--                    [t-40, t-1] whose high is within 2% of base_high, so a
--                    flat base (or an exact retest, common with prices stored
--                    to 2 decimals) counts its full length instead of 1; 1..40
--                    (the window is 40 sessions, so 40 is the ceiling)
--   ret_<N>m_pct     close vs the close on the last session on or before
--                    as_of - N months (calendar), NULL when that session is
--                    more than 10 days before the target (a gap is not a
--                    return)
--   rs_<N>m_pct      ret_<N>m_pct minus XJO's return over the SAME calendar
--                    window (XJO close on or before the stock's anchor date to
--                    XJO close on or before as_of), in percentage points;
--                    NULL when index_prices has no XJO close within 7 days of
--                    either end
-- High/low fall back to close when missing or out of range, and are clamped
-- so high >= close >= low (hence pct_off_52w_high <= 0 <= pct_above_52w_low).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_price_features AS
WITH px AS (
    SELECT sp.stock_code,
           sp.date,
           sp.close::float8                                                        AS close,
           GREATEST(CASE WHEN sp.high > 0 AND sp.high <= 99999999.99 THEN sp.high END,
                    sp.close)::float8                                              AS high,
           LEAST(CASE WHEN sp.low > 0 AND sp.low <= 99999999.99 THEN sp.low END,
                 sp.close)::float8                                                 AS low,
           CASE WHEN sp.volume >= 0 THEN sp.volume ELSE 0 END::bigint              AS volume
    FROM stock_prices sp
    WHERE sp.date >= CURRENT_DATE - 400
      AND sp.date <= CURRENT_DATE
      AND sp.close > 0
      AND sp.close <= 99999999.99
),
seq AS (
    -- One sort: every window here is PARTITION BY stock_code [ORDER BY date].
    SELECT px.stock_code, px.date, px.close, px.high, px.low, px.volume,
           count(*)                OVER wp                                                  AS n_sessions,
           row_number()            OVER w                                                   AS rn_asc,
           max(px.high)            OVER (w ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING)       AS prior40_high,
           count(*)                OVER (w ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING)       AS prior40_n,
           avg(px.volume::float8)  OVER (w ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING)       AS prior50_avg_volume,
           count(*)                OVER (w ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING)       AS prior50_n,
           -- Calendar anchors: the last session on or before date - N months.
           max(px.date)            OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '1 month'   PRECEDING) AS d1m,
           last_value(px.close)    OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '1 month'   PRECEDING) AS c1m,
           max(px.date)            OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '3 months'  PRECEDING) AS d3m,
           last_value(px.close)    OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '3 months'  PRECEDING) AS c3m,
           max(px.date)            OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '6 months'  PRECEDING) AS d6m,
           last_value(px.close)    OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '6 months'  PRECEDING) AS c6m,
           max(px.date)            OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '12 months' PRECEDING) AS d12m,
           last_value(px.close)    OVER (w RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '12 months' PRECEDING) AS c12m
    FROM px
    WINDOW wp AS (PARTITION BY px.stock_code),
           w  AS (PARTITION BY px.stock_code ORDER BY px.date)
),
ranked AS (
    SELECT s.*,
           s.n_sessions - s.rn_asc + 1 AS rn,
           COALESCE(s.prior40_n = 40
                    AND s.close > s.prior40_high
                    AND s.prior50_n >= 20
                    AND s.prior50_avg_volume > 0
                    AND s.volume >= 1.5 * s.prior50_avg_volume, false)            AS is_breakout
    FROM seq s
),
anchored AS (
    -- The base's anchor session on every row: the earliest (largest rn)
    -- breakout in rn 1..5, else as_of. A whole-partition window over input
    -- already sorted by (stock_code, date): no second sort, no second scan.
    SELECT r.*,
           COALESCE(max(r.rn) FILTER (WHERE r.rn <= 5 AND r.is_breakout)
                        OVER (PARTITION BY r.stock_code), 1)                   AS anchor_rn
    FROM ranked r
),
pivoted AS (
    -- The anchor's prior-40 high (the pivot) on every row, so the base's low
    -- and length can be read off the anchor's window in the aggregate below.
    SELECT a.*,
           max(a.prior40_high) FILTER (WHERE a.rn = a.anchor_rn AND a.prior40_n = 40)
               OVER (PARTITION BY a.stock_code)                                AS pivot
    FROM anchored a
),
agg AS (
    SELECT r.stock_code,
           max(r.date)                                                          AS as_of,
           max(r.close)  FILTER (WHERE r.rn = 1)                                AS close,
           max(r.close)  FILTER (WHERE r.rn = 2)                                AS prev_close,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 10)  = 10
                THEN avg(r.close) FILTER (WHERE r.rn <= 10)  END                AS sma10,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 20)  = 20
                THEN avg(r.close) FILTER (WHERE r.rn <= 20)  END                AS sma20,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 50)  = 50
                THEN avg(r.close) FILTER (WHERE r.rn <= 50)  END                AS sma50,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 150) = 150
                THEN avg(r.close) FILTER (WHERE r.rn <= 150) END                AS sma150,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 200) = 200
                THEN avg(r.close) FILTER (WHERE r.rn <= 200) END                AS sma200,
           CASE WHEN count(*) FILTER (WHERE r.rn BETWEEN 22 AND 221) = 200
                THEN avg(r.close) FILTER (WHERE r.rn BETWEEN 22 AND 221) END    AS sma200_1m_ago,
           max(r.high)   FILTER (WHERE r.rn <= 252)                             AS high_52w,
           min(r.low)    FILTER (WHERE r.rn <= 252)                             AS low_52w,
           max(r.volume) FILTER (WHERE r.rn = 1)                                AS volume,
           CASE WHEN count(*) FILTER (WHERE r.rn BETWEEN 2 AND 51) >= 20
                THEN avg(r.volume::float8) FILTER (WHERE r.rn BETWEEN 2 AND 51) END AS avg_volume_50d,
           CASE WHEN count(*) FILTER (WHERE r.rn <= 20) >= 10
                THEN avg(r.close * r.volume::float8) FILTER (WHERE r.rn <= 20) END  AS dollar_volume_20d,
           -- The base over the anchor's window [t-40, t-1] = rn anchor_rn+1 ..
           -- anchor_rn+40 (anchor_rn is constant within a stock).
           max(r.pivot)                                                         AS base_high,
           CASE WHEN count(*) FILTER (WHERE r.rn BETWEEN r.anchor_rn + 1 AND r.anchor_rn + 40) = 40
                THEN min(r.low) FILTER (WHERE r.rn BETWEEN r.anchor_rn + 1 AND r.anchor_rn + 40) END AS base_low,
           (max(r.rn) FILTER (WHERE r.rn BETWEEN r.anchor_rn + 1 AND r.anchor_rn + 40
                                AND r.high >= 0.98 * r.pivot)
            - max(r.anchor_rn))::int                                            AS base_length_days,
           COALESCE(bool_or(r.is_breakout) FILTER (WHERE r.rn <= 5), false)     AS breakout_recent,
           max(r.date)   FILTER (WHERE r.rn <= 5 AND r.is_breakout)             AS breakout_date,
           max(r.d1m)    FILTER (WHERE r.rn = 1)                                AS d1m,
           max(r.c1m)    FILTER (WHERE r.rn = 1)                                AS c1m,
           max(r.d3m)    FILTER (WHERE r.rn = 1)                                AS d3m,
           max(r.c3m)    FILTER (WHERE r.rn = 1)                                AS c3m,
           max(r.d6m)    FILTER (WHERE r.rn = 1)                                AS d6m,
           max(r.c6m)    FILTER (WHERE r.rn = 1)                                AS c6m,
           max(r.d12m)   FILTER (WHERE r.rn = 1)                                AS d12m,
           max(r.c12m)   FILTER (WHERE r.rn = 1)                                AS c12m,
           count(*)::int                                                        AS sessions_available
    FROM pivoted r
    WHERE r.n_sessions >= 60
      AND r.rn <= 260
    GROUP BY r.stock_code
),
rets AS (
    SELECT a.*,
           CASE WHEN a.c1m  > 0 AND a.d1m  >= (a.as_of - INTERVAL '1 month'   - INTERVAL '10 days')::date
                THEN (a.close / a.c1m  - 1) * 100 END                           AS ret_1m_pct,
           CASE WHEN a.c3m  > 0 AND a.d3m  >= (a.as_of - INTERVAL '3 months'  - INTERVAL '10 days')::date
                THEN (a.close / a.c3m  - 1) * 100 END                           AS ret_3m_pct,
           CASE WHEN a.c6m  > 0 AND a.d6m  >= (a.as_of - INTERVAL '6 months'  - INTERVAL '10 days')::date
                THEN (a.close / a.c6m  - 1) * 100 END                           AS ret_6m_pct,
           CASE WHEN a.c12m > 0 AND a.d12m >= (a.as_of - INTERVAL '12 months' - INTERVAL '10 days')::date
                THEN (a.close / a.c12m - 1) * 100 END                           AS ret_12m_pct
    FROM agg a
)
SELECT
    r.stock_code,
    r.as_of,
    r.close,
    r.prev_close,
    r.sma10,
    r.sma20,
    r.sma50,
    r.sma150,
    r.sma200,
    r.sma200_1m_ago,
    r.high_52w,
    r.low_52w,
    CASE WHEN r.high_52w > 0 THEN LEAST(0, (r.close - r.high_52w) / r.high_52w * 100) END AS pct_off_52w_high,
    CASE WHEN r.low_52w  > 0 THEN GREATEST(0, (r.close - r.low_52w) / r.low_52w * 100) END AS pct_above_52w_low,
    r.volume,
    r.avg_volume_50d,
    CASE WHEN r.avg_volume_50d > 0 THEN r.volume::float8 / r.avg_volume_50d END            AS volume_ratio_50d,
    r.dollar_volume_20d,
    r.base_high,
    r.base_low,
    CASE WHEN r.base_high > 0 AND r.base_low IS NOT NULL
         THEN (r.base_high - r.base_low) / r.base_high * 100 END                           AS base_depth_pct,
    r.base_length_days,
    r.breakout_recent,
    r.breakout_date,
    r.ret_1m_pct,
    r.ret_3m_pct,
    r.ret_6m_pct,
    r.ret_12m_pct,
    CASE WHEN r.ret_3m_pct IS NOT NULL AND x3.close > 0 AND x0.close > 0
              AND x0.date >= r.as_of - 7 AND x3.date >= r.d3m - 7
         THEN r.ret_3m_pct - (x0.close / x3.close - 1) * 100 END                           AS rs_3m_pct,
    CASE WHEN r.ret_6m_pct IS NOT NULL AND x6.close > 0 AND x0.close > 0
              AND x0.date >= r.as_of - 7 AND x6.date >= r.d6m - 7
         THEN r.ret_6m_pct - (x0.close / x6.close - 1) * 100 END                           AS rs_6m_pct,
    r.sessions_available
FROM rets r
LEFT JOIN LATERAL (
    SELECT ip.date, ip.close FROM index_prices ip
    WHERE ip.index_code = 'XJO' AND ip.date <= r.as_of
      AND ip.close > 0 AND ip.close < 'Infinity'::float8
    ORDER BY ip.date DESC LIMIT 1
) x0 ON true
LEFT JOIN LATERAL (
    SELECT ip.date, ip.close FROM index_prices ip
    WHERE ip.index_code = 'XJO' AND ip.date <= r.d3m
      AND ip.close > 0 AND ip.close < 'Infinity'::float8
    ORDER BY ip.date DESC LIMIT 1
) x3 ON true
LEFT JOIN LATERAL (
    SELECT ip.date, ip.close FROM index_prices ip
    WHERE ip.index_code = 'XJO' AND ip.date <= r.d6m
      AND ip.close > 0 AND ip.close < 'Infinity'::float8
    ORDER BY ip.date DESC LIMIT 1
) x6 ON true
WITH DATA;

-- REFRESH ... CONCURRENTLY needs a unique index on plain columns.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_price_features_stock_code
    ON mv_price_features (stock_code);

COMMENT ON MATERIALIZED VIEW mv_price_features IS
    'One row per stock with >= 60 sessions in the last 400 days: SMAs, 52w range, volume ratio, 40-session base (pivot, depth, length), recent breakout on volume, calendar returns and RS vs XJO. Refreshed by refresh_strategy_views().';

-- ---------------------------------------------------------------------------
-- 3. refresh_strategy_views(): the 000095 guard pattern, cheapest view first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_strategy_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Four index rows: can never be hostage to the expensive views below.
    RAISE NOTICE 'Refreshing mv_market_regime (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_market_regime;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_market_regime concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_market_regime;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_market_regime: %', SQLERRM;
    END;

    -- ~2,300 codes x ~10 fundamentals rows, primary-key probes.
    RAISE NOTICE 'Refreshing mv_fundamentals_growth (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_fundamentals_growth;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_fundamentals_growth concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_fundamentals_growth;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_fundamentals_growth: %', SQLERRM;
    END;

    -- The expensive one: 400 days of prices, sorted once.
    RAISE NOTICE 'Refreshing mv_price_features (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_price_features;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_price_features concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_price_features;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_price_features: %', SQLERRM;
    END;

    RAISE NOTICE 'Strategy views refresh finished.';
END;
$$;

-- Function-scoped GUC. As 000095 measured, this cannot disarm a timer the
-- CALLING command already armed, so the caller still sends
-- `SET LOCAL statement_timeout = 0` first (picks/refresh.go); this covers any
-- caller that starts a fresh command inside the function's scope.
ALTER FUNCTION refresh_strategy_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_strategy_views() IS
    'Refreshes the stock-picker views cheapest-first (mv_market_regime, mv_fundamentals_growth, mv_price_features). Each refresh is individually guarded (concurrent, then non-concurrent fallback, then WARNING ''Skipping <view>''; handlers name query_canceled explicitly) so one failing view cannot starve the rest. Called by `shorted picks -mode refresh` after the daily price sweep.';

COMMIT;
