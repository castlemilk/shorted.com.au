-- Reverse 000132: back to 000129's growth view and 000130's refresh function.
--
-- The same two-transaction shape and lock order as the up migration:
--   1. refresh_strategy_views() re-issued with 000130's three-view body
--      (verbatim), committed first, so nothing is left refreshing a view this
--      file is about to drop.
--   2. in refresh_strategy_views() order: document_meta and picks_run_lease
--      (no picker view reads them), then mv_fundamentals_growth (dropped only
--      while it is 000132's definition, with 000132's dependency check and
--      carry of owner, storage options and grants), then
--      mv_fundamentals_quality, then the added columns and the v2 CHECK, and
--      finally 000129's mv_fundamentals_growth definition (verbatim), its
--      unique index and 000129's COMMENT.
-- The growth view goes before the quality view because a refresh still
-- running 000132's four-view body holds the growth view before it takes the
-- quality view.
--
-- Dropping the columns discards the data they hold (the full statements,
-- field_sources, the document links, the sync outcome counters and every
-- extraction's document_meta). The rows of stock_fundamentals themselves, and
-- their 000129 columns, are kept.

-- ===========================================================================
-- Transaction 1: 000130's refresh_strategy_views(), verbatim
-- ===========================================================================
BEGIN;

SET LOCAL statement_timeout = 0;

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

-- ===========================================================================
-- Transaction 2: tables, columns and views, in refresh_strategy_views() order
-- ===========================================================================
BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';

ALTER TABLE IF EXISTS financial_report_extractions DROP COLUMN IF EXISTS document_meta;

DROP TABLE IF EXISTS picks_run_lease;

-- mv_fundamentals_growth: only while it is 000132's definition.
DO $m132$
DECLARE
    growth     oid := to_regclass('mv_fundamentals_growth');
    dependents text;
BEGIN
    IF growth IS NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = growth AND attname = 'revenue_prior_period_end' AND NOT attisdropped) THEN
        RETURN;  -- already 000129's definition
    END IF;

    SELECT string_agg(DISTINCT
               CASE WHEN d.classid = 'pg_rewrite'::regclass
                    THEN (SELECT r.ev_class::regclass::text FROM pg_rewrite r WHERE r.oid = d.objid)
                    ELSE pg_describe_object(d.classid, d.objid, d.objsubid) END, ', ')
      INTO dependents
      FROM pg_depend d
     WHERE d.refclassid = 'pg_class'::regclass
       AND d.refobjid = growth
       AND d.deptype = 'n'
       AND NOT (d.classid = 'pg_rewrite'::regclass
                AND EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.oid = d.objid AND r.ev_class = growth));
    IF dependents IS NOT NULL THEN
        RAISE EXCEPTION 'mv_fundamentals_growth cannot be rebuilt: % depend(s) on it. Drop or repoint them, then re-run this migration.', dependents;
    END IF;

    CREATE TEMP TABLE _m132_growth_carry ON COMMIT DROP AS
    SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions, c.relacl
      FROM pg_class c
     WHERE c.oid = growth;

    EXECUTE format('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth');
END
$m132$;

DROP MATERIALIZED VIEW IF EXISTS mv_fundamentals_quality;

ALTER TABLE stock_fundamentals
    DROP CONSTRAINT IF EXISTS stock_fundamentals_finite_check_v2,
    DROP COLUMN IF EXISTS gross_profit,
    DROP COLUMN IF EXISTS operating_income,
    DROP COLUMN IF EXISTS ebitda,
    DROP COLUMN IF EXISTS normalized_ebitda,
    DROP COLUMN IF EXISTS ebit,
    DROP COLUMN IF EXISTS interest_expense,
    DROP COLUMN IF EXISTS pretax_income,
    DROP COLUMN IF EXISTS tax_provision,
    DROP COLUMN IF EXISTS net_interest_income,
    DROP COLUMN IF EXISTS capital_expenditure,
    DROP COLUMN IF EXISTS dividends_paid,
    DROP COLUMN IF EXISTS share_buybacks,
    DROP COLUMN IF EXISTS total_assets,
    DROP COLUMN IF EXISTS total_liabilities,
    DROP COLUMN IF EXISTS total_equity,
    DROP COLUMN IF EXISTS cash_and_equivalents,
    DROP COLUMN IF EXISTS total_debt,
    DROP COLUMN IF EXISTS capital_lease_obligations,
    DROP COLUMN IF EXISTS net_debt,
    DROP COLUMN IF EXISTS current_assets,
    DROP COLUMN IF EXISTS current_liabilities,
    DROP COLUMN IF EXISTS field_sources,
    DROP COLUMN IF EXISTS source_document_url,
    DROP COLUMN IF EXISTS source_document_date;

ALTER TABLE stock_fundamentals_sync
    DROP COLUMN IF EXISTS last_outcome,
    DROP COLUMN IF EXISTS consecutive_empty,
    DROP COLUMN IF EXISTS median_k;

-- 000129's definition, verbatim (a no-op when it was never replaced).
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

DO $m132$
DECLARE
    note  constant text := 'One row per stock: revenue/net income/OCF growth annual vs prior annual, EPS growth TTM vs TTM a year earlier (else annual), half vs the same half a year earlier from filing rows (*_half_yoy_pct), and revenue/EPS switch to the half basis when the half is newer (revenue_basis_period_type / basis_period_type = half). Half-year deltas via TTM - FY. Every *_yoy_pct is NULL unless the prior is > 0, same currency, 10-14 months earlier. Refreshed by refresh_strategy_views() (000130).';
    carry record;
    item  record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = current_schema()
                     AND tablename = 'mv_fundamentals_growth'
                     AND indexname = 'idx_mv_fundamentals_growth_stock_code') THEN
        EXECUTE 'CREATE UNIQUE INDEX idx_mv_fundamentals_growth_stock_code ON mv_fundamentals_growth (stock_code)';
    END IF;

    IF to_regclass('pg_temp._m132_growth_carry') IS NOT NULL THEN
        FOR carry IN SELECT * FROM pg_temp._m132_growth_carry LOOP
            IF carry.owner <> current_user THEN
                EXECUTE format('ALTER MATERIALIZED VIEW %I OWNER TO %I', 'mv_fundamentals_growth', carry.owner);
            END IF;
            IF carry.reloptions IS NOT NULL THEN
                EXECUTE format('ALTER MATERIALIZED VIEW %I SET (%s)', 'mv_fundamentals_growth',
                               array_to_string(carry.reloptions, ', '));
            END IF;
            FOR item IN
                SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
                WHERE c.oid = 'mv_fundamentals_growth'::regclass AND a.grantee <> c.relowner
            LOOP
                EXECUTE format('REVOKE ALL ON TABLE %I FROM %s', 'mv_fundamentals_growth',
                    CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END);
            END LOOP;
            FOR item IN
                SELECT a.grantee, a.privilege_type, a.is_grantable
                FROM aclexplode(carry.relacl) a
                WHERE a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = carry.owner)
            LOOP
                EXECUTE format('GRANT %s ON TABLE %I TO %s%s', item.privilege_type, 'mv_fundamentals_growth',
                    CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
                    CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
            END LOOP;
        END LOOP;
    END IF;

    IF obj_description('mv_fundamentals_growth'::regclass, 'pg_class') IS DISTINCT FROM note THEN
        EXECUTE format('COMMENT ON MATERIALIZED VIEW mv_fundamentals_growth IS %L', note);
    END IF;
END
$m132$;

COMMIT;
