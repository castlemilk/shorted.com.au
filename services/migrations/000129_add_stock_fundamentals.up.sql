-- Migration 000129: typed per-period company fundamentals + growth view
-- (stock picker, docs/plans/stock-picker.md §2.1-2.2)
--
-- The strategy engine's growth rules (Zanger's "explosive earnings and revenue
-- growth", CAN SLIM's current + annual EPS) need statement LINES per period,
-- typed, with the period they belong to. "company-metadata".key_metrics has
-- one untyped snapshot per company and no period, so it cannot say what
-- revenue was a year ago. This adds one row per (stock, period_type,
-- period_end), written only by the `shorted picks` job: -mode fundamentals
-- from Yahoo's fundamentals-timeseries (fallback: Markit key statistics), and
-- -mode filings, which parses the half-year and full-year totals the
-- report-extractor already pulled out of Appendix 4D/4E filings
-- (financial_report_extractions.metrics) into typed rows, source
-- 'asx-filing-extraction'. No LLM runs in this path: the filing mode only
-- accepts a value it can find in the extraction's own quoted sentence, and it
-- never overwrites a vendor's value (picks/store.go filingUpsertSQL).
--
-- WHY TTM. Yahoo carries no half-year totals for ASX companies (probe
-- 2026-09-27: every "quarterly" P&L series is empty). What it does carry is a
-- trailing-twelve-month EPS point at every half-year end, so TTM EPS is the
-- freshest EPS series we can get: TTM vs the TTM point a year earlier moves
-- every six months, annual vs annual only every twelve. Revenue / profit /
-- cash flow only exist as TTM at the latest one or two points, so their growth
-- is annual vs prior annual. The exact identity
--     TTM(latest half end) - FY(last) = H(latest) - H(same half a year earlier)
-- still gives the sign of the latest half against the prior corresponding
-- period, which is exposed as *_half_delta (absolute, reporting currency).
--
-- WHY NULL, NEVER 0, AND WHY A CASE GUARD. A growth rate against a prior that
-- is missing, zero or negative is not a number: "+300% from a loss" is noise
-- and a division by zero or by a denormal is an error or an Infinity. Every
-- *_yoy_pct is `CASE WHEN prior > 0 ... END`, so it is NULL unless the prior is
-- strictly positive, the two points share a currency and they are 10-14
-- months apart. "Prior loss, now profit" is reported through
-- net_income_positive + net_income_prior <= 0, not as a percentage. The
-- key_metrics incident (±Inf reaching encoding/json and killing MCP,
-- docs/superpowers/handover-2026-08-29-mcp-oauth.md) is why nothing here may
-- ever produce a non-finite value: the table CHECK below refuses NaN, ±Inf and
-- implausible magnitudes at the write funnel (the job enforces the same range
-- before it writes), which also bounds every ratio the view computes, so no
-- division in it can overflow or underflow.
--
-- Growth is only ever computed WITHIN one series (annual vs annual, TTM vs
-- TTM) and one currency. Values are stored in the REPORTING currency (BHP
-- reports in USD) exactly as the source gives them; FX cancels inside a
-- series and would not across one.
--
-- REPLAY-SAFE: every statement is CREATE ... IF NOT EXISTS / COMMENT, nothing
-- reads or writes a row, and the view is only built when absent (a replay
-- never rebuilds it), so this is safe in the deploy allowlist, which re-runs it
-- on every deploy. Changing the view's definition later therefore needs a NEW
-- migration that is hand-applied, never an edit here.
--
-- EDITED IN PLACE ONCE, 2026-09-27, before any shared database applied it:
-- the half-year columns (revenue_half_yoy_pct, net_income_half_yoy_pct,
-- eps_half_yoy_pct, half_latest_period_end, revenue_basis_period_type) and the
-- half-preferred basis selection were added to mv_fundamentals_growth. A
-- database that already built the EARLIER definition (a laptop or scratch DB)
-- keeps it, because CREATE MATERIALIZED VIEW IF NOT EXISTS is a no-op there.
-- Fix: `DROP MATERIALIZED VIEW mv_fundamentals_growth;` then re-apply this
-- file (the tables are untouched; the view is rebuilt from them).
--
-- Hand-apply BEFORE merging the API that reads it (plan §7): session pooler
-- 5432, `task db:prod:apply FILE=... CONFIRM=prod`. The whole file is one
-- BEGIN ... COMMIT with the timeout disarmed in-session (Supavisor drops
-- PGOPTIONS), which prod-psql's classifier accepts as a single transaction.

BEGIN;

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1. stock_fundamentals: one row per (stock, period_type, period_end)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_fundamentals (
    stock_code          VARCHAR(10)      NOT NULL,
    period_type         VARCHAR(8)       NOT NULL,  -- 'annual' | 'half' | 'quarter' | 'ttm'
    period_end          DATE             NOT NULL,
    fiscal_year         SMALLINT,                   -- FY the period belongs to (derived; ASX default FY ends 30 June)
    currency            VARCHAR(8)       NOT NULL DEFAULT 'AUD',
    revenue             DOUBLE PRECISION,           -- total revenue, whole currency units
    net_income          DOUBLE PRECISION,           -- NPAT (NetIncomeCommonStockholders)
    eps_basic           DOUBLE PRECISION,
    eps_diluted         DOUBLE PRECISION,
    operating_cash_flow DOUBLE PRECISION,
    free_cash_flow      DOUBLE PRECISION,
    shares_outstanding  DOUBLE PRECISION,
    source              VARCHAR(32)      NOT NULL,  -- 'yahoo-timeseries' | 'markit-key-statistics' | 'asx-filing-extraction'
    source_fetched_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT stock_fundamentals_pk PRIMARY KEY (stock_code, period_type, period_end),
    CONSTRAINT stock_fundamentals_period_type_check CHECK (period_type IN ('annual','half','quarter','ttm')),
    -- Finite and plausible, or NULL. In Postgres NaN compares GREATER than every
    -- number, so `x BETWEEN -1e18 AND 1e18` is false for NaN and for ±Infinity.
    -- The 1e-12 floor refuses denormal-scale values, which no statement line
    -- has (EPS is reported to four decimals, the rest in whole units) and which
    -- are the only way a growth ratio in mv_fundamentals_growth could overflow.
    -- The job applies the identical range before writing (picks/rows.go
    -- storable), so a real write never trips this; it is the backstop.
    CONSTRAINT stock_fundamentals_finite_check CHECK (
        (revenue             IS NULL OR revenue = 0             OR abs(revenue)             BETWEEN 1e-12 AND 1e18) AND
        (net_income          IS NULL OR net_income = 0          OR abs(net_income)          BETWEEN 1e-12 AND 1e18) AND
        (eps_basic           IS NULL OR eps_basic = 0           OR abs(eps_basic)           BETWEEN 1e-12 AND 1e18) AND
        (eps_diluted         IS NULL OR eps_diluted = 0         OR abs(eps_diluted)         BETWEEN 1e-12 AND 1e18) AND
        (operating_cash_flow IS NULL OR operating_cash_flow = 0 OR abs(operating_cash_flow) BETWEEN 1e-12 AND 1e18) AND
        (free_cash_flow      IS NULL OR free_cash_flow = 0      OR abs(free_cash_flow)      BETWEEN 1e-12 AND 1e18) AND
        (shares_outstanding  IS NULL OR shares_outstanding = 0  OR abs(shares_outstanding)  BETWEEN 1e-12 AND 1e18)
    )
);

CREATE INDEX IF NOT EXISTS idx_stock_fundamentals_code_end
    ON stock_fundamentals (stock_code, period_end DESC);

COMMENT ON TABLE stock_fundamentals IS
    'Typed per-period statement lines, reporting currency. annual / ttm from vendors (`shorted picks -mode fundamentals`: Yahoo timeseries, Markit fallback), half (and annual rows vendors lag on) from company filings (`shorted picks -mode filings`, source asx-filing-extraction, never overwriting a vendor value); quarter reserved. Non-finite and implausible values are refused (stock_fundamentals_finite_check).';

-- ---------------------------------------------------------------------------
-- 2. stock_fundamentals_sync: one row per code, every fetch attempt recorded
--    (drives stalest-first ordering and the 6-day skip).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_fundamentals_sync (
    stock_code       VARCHAR(10) PRIMARY KEY,
    last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_success_at  TIMESTAMPTZ,
    last_error       TEXT,
    periods_loaded   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 3. mv_fundamentals_growth: one row per stock with any fundamentals row.
--
-- Bases (plan §2.2):
--   revenue / net income / operating cash flow: the latest annual row (a1) vs
--     the annual row 10-14 months before it (a0); the *_yoy_prior_pct growth
--     is a0 vs the annual row 10-14 months before a0 (am1).
--   EPS (diluted, the only EPS series fetched on both bases): the latest TTM
--     point with an EPS (e1) vs the TTM point 10-14 months before it (e0),
--     when both exist and e1 is not older than the latest annual EPS; else
--     annual (ae1 vs ae0).
--   Half-year growth (filing rows, period_type 'half'): the latest half (h1)
--     vs the half 10-14 months before it (h0), i.e. the same half a year
--     earlier; the prior growth is h0 vs hm1. Exposed as revenue_half_yoy_pct
--     / net_income_half_yoy_pct / eps_half_yoy_pct with half_latest_period_end,
--     under the same guards (NULL unless the prior is > 0 and the two share a
--     currency). Half EPS compares diluted with diluted when both halves carry
--     it, else basic with basic, never one with the other.
--   HALF IS PREFERRED WHEN IT IS FRESHER (plan §2.2's original intent; the
--     vendor cannot supply halves, filings can). Per series:
--       revenue: when revenue_half_yoy_pct exists and h1 ends AFTER a1,
--         revenue_latest / _prior / _yoy_pct / _yoy_prior_pct are the half
--         values and revenue_basis_period_type = 'half' (else 'annual').
--       EPS: when eps_half_yoy_pct exists and h1 ends AFTER the EPS basis's
--         latest point (e1 on the ttm basis, ae1 on the annual), eps_latest /
--         _prior / _yoy_pct / _yoy_prior_pct are the half values,
--         basis_period_type = 'half' and latest_period_end = h1's end.
--     Strictly after: a TTM point on the same date as the half is as fresh
--     and smoother, so it keeps the basis. basis_period_type still records
--     the EPS series ('half' | 'ttm' | 'annual'); latest_period_end is the
--     date of the EPS basis's latest point (the revenue basis's date is
--     latest_annual_period_end, or half_latest_period_end when
--     revenue_basis_period_type = 'half').
--   Half deltas: the latest TTM row (t1) minus a1, only when t1 is 5-7 months
--     after a1 (i.e. it IS the first half after that year: at +12 months the
--     same subtraction is a full-year change, not a half) and in the same
--     currency.
--
-- "10-14 months apart" instead of "the previous row" so a missing year or a
-- change of balance date yields NULL rather than a growth rate across two
-- different spans.
--
-- Cost: the table is ~2,300 codes x ~12 rows; every LATERAL is a primary-key
-- range probe (stock_code, period_type, period_end).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_growth AS
WITH codes AS (
    SELECT f.stock_code,
           count(*)::int              AS periods_available,
           max(f.source_fetched_at)   AS fetched_at
    FROM stock_fundamentals f
    GROUP BY f.stock_code
)
SELECT
    c.stock_code,
    CASE WHEN half_basis.eps THEN 'half' WHEN eps_ttm_ok.ok THEN 'ttm' ELSE 'annual' END::varchar(8) AS basis_period_type,
    CASE WHEN half_basis.eps THEN h1.period_end
         WHEN eps_ttm_ok.ok THEN e1.period_end
         ELSE COALESCE(ae1.period_end, a1.period_end, t1.period_end, h1.period_end) END AS latest_period_end,
    a1.period_end                                                          AS latest_annual_period_end,

    CASE WHEN half_basis.rev THEN h1.revenue ELSE a1.revenue END           AS revenue_latest,
    CASE WHEN half_basis.rev THEN h0.revenue ELSE a0.revenue END           AS revenue_prior,
    CASE WHEN half_basis.rev THEN hg.revenue_yoy
         ELSE CASE WHEN a0.revenue > 0 AND a1.revenue IS NOT NULL AND a1.currency = a0.currency
                   THEN (a1.revenue - a0.revenue) / a0.revenue * 100 END
    END                                                                    AS revenue_yoy_pct,
    CASE WHEN half_basis.rev THEN hg.revenue_yoy_prior
         ELSE CASE WHEN am1.revenue > 0 AND a0.revenue IS NOT NULL AND a0.currency = am1.currency
                   THEN (a0.revenue - am1.revenue) / am1.revenue * 100 END
    END                                                                    AS revenue_yoy_prior_pct,

    CASE WHEN half_basis.eps THEN he.latest
         WHEN eps_ttm_ok.ok THEN e1.eps_diluted ELSE ae1.eps_diluted END   AS eps_latest,
    CASE WHEN half_basis.eps THEN he.prior
         WHEN eps_ttm_ok.ok THEN e0.eps_diluted ELSE ae0.eps_diluted END   AS eps_prior,
    CASE WHEN half_basis.eps THEN hg.eps_yoy
         WHEN eps_ttm_ok.ok THEN
             CASE WHEN e0.eps_diluted > 0 AND e1.currency = e0.currency
                  THEN (e1.eps_diluted - e0.eps_diluted) / e0.eps_diluted * 100 END
         ELSE
             CASE WHEN ae0.eps_diluted > 0 AND ae1.eps_diluted IS NOT NULL AND ae1.currency = ae0.currency
                  THEN (ae1.eps_diluted - ae0.eps_diluted) / ae0.eps_diluted * 100 END
    END                                                                    AS eps_yoy_pct,
    CASE WHEN half_basis.eps THEN hg.eps_yoy_prior
         WHEN eps_ttm_ok.ok THEN
             CASE WHEN em1.eps_diluted > 0 AND e0.currency = em1.currency
                  THEN (e0.eps_diluted - em1.eps_diluted) / em1.eps_diluted * 100 END
         ELSE
             CASE WHEN aem1.eps_diluted > 0 AND ae0.eps_diluted IS NOT NULL AND ae0.currency = aem1.currency
                  THEN (ae0.eps_diluted - aem1.eps_diluted) / aem1.eps_diluted * 100 END
    END                                                                    AS eps_yoy_prior_pct,

    a1.net_income                                                          AS net_income_latest,
    a0.net_income                                                          AS net_income_prior,
    (a1.net_income > 0)                                                    AS net_income_positive,
    a1.operating_cash_flow                                                 AS operating_cash_flow_latest,

    t1.revenue                                                             AS revenue_ttm,
    t1.net_income                                                          AS net_income_ttm,
    t1.eps_diluted                                                         AS eps_ttm,

    CASE WHEN half_ok.ok THEN t1.revenue - a1.revenue END                  AS revenue_half_delta,
    CASE WHEN half_ok.ok THEN t1.net_income - a1.net_income END            AS net_income_half_delta,

    COALESCE(a1.currency, t1.currency, h1.currency)::varchar(8)            AS currency,
    c.periods_available,
    c.fetched_at,

    hg.revenue_yoy                                                         AS revenue_half_yoy_pct,
    hg.net_income_yoy                                                      AS net_income_half_yoy_pct,
    hg.eps_yoy                                                             AS eps_half_yoy_pct,
    h1.period_end                                                          AS half_latest_period_end,
    CASE WHEN half_basis.rev THEN 'half' ELSE 'annual' END::varchar(8)     AS revenue_basis_period_type
FROM codes c
-- Annual rows (revenue / net income / OCF basis).
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.operating_cash_flow
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual'
    ORDER BY f.period_end DESC
    LIMIT 1
) a1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual'
      AND f.period_end BETWEEN (a1.period_end - INTERVAL '14 months')::date
                           AND (a1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) a0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual'
      AND f.period_end BETWEEN (a0.period_end - INTERVAL '14 months')::date
                           AND (a0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) am1 ON true
-- Annual rows carrying an EPS (the EPS fallback basis). Separate from a1 because
-- a Markit-sourced annual row has revenue and profit but no EPS.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.eps_diluted IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) ae1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.eps_diluted IS NOT NULL
      AND f.period_end BETWEEN (ae1.period_end - INTERVAL '14 months')::date
                           AND (ae1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) ae0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.eps_diluted IS NOT NULL
      AND f.period_end BETWEEN (ae0.period_end - INTERVAL '14 months')::date
                           AND (ae0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) aem1 ON true
-- TTM rows. t1 is the latest TTM point of any kind (revenue / profit / EPS
-- snapshots); e1/e0/em1 are the TTM EPS series.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm'
    ORDER BY f.period_end DESC
    LIMIT 1
) t1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm' AND f.eps_diluted IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) e1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm' AND f.eps_diluted IS NOT NULL
      AND f.period_end BETWEEN (e1.period_end - INTERVAL '14 months')::date
                           AND (e1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) e0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm' AND f.eps_diluted IS NOT NULL
      AND f.period_end BETWEEN (e0.period_end - INTERVAL '14 months')::date
                           AND (e0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) em1 ON true
-- Half rows (company filings). h1 is the latest half; h0 the same half a year
-- earlier; hm1 the one a year before that.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.eps_basic, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
    ORDER BY f.period_end DESC
    LIMIT 1
) h1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.eps_basic, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
      AND f.period_end BETWEEN (h1.period_end - INTERVAL '14 months')::date
                           AND (h1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) h0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.eps_basic, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
      AND f.period_end BETWEEN (h0.period_end - INTERVAL '14 months')::date
                           AND (h0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) hm1 ON true
-- Half EPS on ONE measure per pair: diluted when both halves carry it, else
-- basic (a filing usually quotes basic only).
CROSS JOIN LATERAL (
    SELECT CASE WHEN h1.eps_diluted IS NOT NULL AND h0.eps_diluted IS NOT NULL THEN h1.eps_diluted ELSE h1.eps_basic END   AS latest,
           CASE WHEN h1.eps_diluted IS NOT NULL AND h0.eps_diluted IS NOT NULL THEN h0.eps_diluted ELSE h0.eps_basic END   AS prior,
           CASE WHEN h0.eps_diluted IS NOT NULL AND hm1.eps_diluted IS NOT NULL THEN h0.eps_diluted ELSE h0.eps_basic END  AS prior_latest,
           CASE WHEN h0.eps_diluted IS NOT NULL AND hm1.eps_diluted IS NOT NULL THEN hm1.eps_diluted ELSE hm1.eps_basic END AS prior_prior
) he
-- Half-on-half growth, same guards as every other *_yoy_pct.
CROSS JOIN LATERAL (
    SELECT
        CASE WHEN h0.revenue > 0 AND h1.revenue IS NOT NULL AND h1.currency = h0.currency
             THEN (h1.revenue - h0.revenue) / h0.revenue * 100 END          AS revenue_yoy,
        CASE WHEN hm1.revenue > 0 AND h0.revenue IS NOT NULL AND h0.currency = hm1.currency
             THEN (h0.revenue - hm1.revenue) / hm1.revenue * 100 END        AS revenue_yoy_prior,
        CASE WHEN h0.net_income > 0 AND h1.net_income IS NOT NULL AND h1.currency = h0.currency
             THEN (h1.net_income - h0.net_income) / h0.net_income * 100 END AS net_income_yoy,
        CASE WHEN he.prior > 0 AND he.latest IS NOT NULL AND h1.currency = h0.currency
             THEN (he.latest - he.prior) / he.prior * 100 END               AS eps_yoy,
        CASE WHEN he.prior_prior > 0 AND he.prior_latest IS NOT NULL AND h0.currency = hm1.currency
             THEN (he.prior_latest - he.prior_prior) / he.prior_prior * 100 END AS eps_yoy_prior
) hg
-- The TTM EPS basis applies when a TTM pair exists and it is not staler than
-- the latest annual EPS (a small-cap whose Markit annual row landed first has
-- no annual EPS, so this only ever prefers the fresher series).
CROSS JOIN LATERAL (
    SELECT (e1.period_end IS NOT NULL AND e0.period_end IS NOT NULL
            AND (ae1.period_end IS NULL OR e1.period_end >= ae1.period_end)) AS ok
) eps_ttm_ok
-- The half basis applies per series when its half growth exists and the half
-- is STRICTLY newer than that series' vendor basis.
CROSS JOIN LATERAL (
    SELECT (hg.revenue_yoy IS NOT NULL
            AND (a1.period_end IS NULL OR h1.period_end > a1.period_end)) AS rev,
           (hg.eps_yoy IS NOT NULL
            AND (CASE WHEN eps_ttm_ok.ok THEN e1.period_end ELSE ae1.period_end END IS NULL
                 OR h1.period_end > CASE WHEN eps_ttm_ok.ok THEN e1.period_end ELSE ae1.period_end END)) AS eps
) half_basis
CROSS JOIN LATERAL (
    SELECT (t1.period_end IS NOT NULL AND a1.period_end IS NOT NULL
            AND t1.currency = a1.currency
            AND t1.period_end BETWEEN (a1.period_end + INTERVAL '5 months')::date
                                  AND (a1.period_end + INTERVAL '7 months')::date) AS ok
) half_ok
WITH DATA;

-- REFRESH ... CONCURRENTLY needs a unique index on plain columns.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fundamentals_growth_stock_code
    ON mv_fundamentals_growth (stock_code);

COMMENT ON MATERIALIZED VIEW mv_fundamentals_growth IS
    'One row per stock: revenue/net income/OCF growth annual vs prior annual, EPS growth TTM vs TTM a year earlier (else annual), half vs the same half a year earlier from filing rows (*_half_yoy_pct), and revenue/EPS switch to the half basis when the half is newer (revenue_basis_period_type / basis_period_type = half). Half-year deltas via TTM - FY. Every *_yoy_pct is NULL unless the prior is > 0, same currency, 10-14 months earlier. Refreshed by refresh_strategy_views() (000130).';

COMMIT;
