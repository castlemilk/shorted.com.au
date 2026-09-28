-- Migration 000132: full statements, per-field provenance, quality ratios
-- (docs/plans/fundamentals-coverage.md §2)
--
-- stock_fundamentals (000129) holds seven statement lines. Yahoo returns the
-- whole income statement, balance sheet and cash-flow statement in the single
-- GET the picks job already makes, so this widens the table to the lines the
-- stock page and the quality strategy need, records which fields did not come
-- from the row's own source (field_sources) and which filing a row came from
-- (source_document_url / _date), rebuilds mv_fundamentals_growth so a
-- balance-only or EPS-only row can never blank a growth figure (and so a
-- fresher TTM revenue point is used), and adds mv_fundamentals_quality: one
-- row per stock of margins, returns, leverage and cash conversion, each on ONE
-- flow row and ONE aligned balance row of the same currency.
--
-- SHAPE (plan §2.0, pinned by fundamentals_extended.test.mjs). Exactly two
-- transactions:
--   1. refresh_strategy_views() re-issued with mv_fundamentals_quality in it,
--      and COMMITTED before any relation lock. The deploy replays 000130 (the
--      three-view body) just before this file, so if transaction 2 then fails,
--      the four-view body is still what is left in place.
--   2. everything else, in the order refresh_strategy_views() locks the picker
--      objects (mv_market_regime -> mv_fundamentals_growth ->
--      mv_fundamentals_quality -> mv_price_features):
--        a. financial_report_extractions.document_meta (no picker object reads it)
--        b. picks_run_lease
--        c. the guarded DROP of mv_fundamentals_growth
--        d. the guarded column adds and the v2 CHECK on stock_fundamentals /
--           stock_fundamentals_sync
--        e. mv_fundamentals_growth rebuilt, its unique index, its COMMENT
--        f. mv_fundamentals_quality, its unique index, its COMMENT
--      A refresh holds EXCLUSIVE on the growth view and then reads
--      stock_fundamentals, so the growth view is dropped BEFORE the table is
--      altered: the other order is a deadlock (this file holding the table,
--      the refresh holding the view and waiting for the table, this file then
--      waiting for the view). Here a running refresh makes this file wait at
--      step c, holding nothing the refresh needs. lock_timeout = '15s' bounds
--      that wait, so a stuck lock fails the deploy step (before any image is
--      swapped) instead of queueing every reader of the table behind it.
--
-- REPLAY-SAFE: the deploy allowlist re-runs this file on every deploy, after
-- 000129, 000130 and 000131. Every step is catalog-guarded: the column adds,
-- the CHECK and the unique indexes run only when the catalog lacks them, the
-- growth view is dropped only while it lacks revenue_prior_period_end (the
-- LAST appended column, emitted by the CREATE below), and the COMMENTs only
-- when the text differs. A replay therefore takes no lock on any picker
-- object. The one exception is the growth view's COMMENT: 000129's replay
-- rewrites it to 000129's text on every deploy, so this file writes it back;
-- that is best effort (a lock it cannot get within lock_timeout is a NOTICE,
-- never a failed deploy). 000129's own CREATE MATERIALIZED VIEW IF NOT EXISTS
-- is a no-op once the rebuilt view exists.
--
-- THE REBUILD (step c). A materialized view's column list cannot be altered,
-- so the first apply drops it and step e builds the new definition. Before the
-- drop, any relation or function that depends on the view stops the migration
-- by name (DROP would refuse anyway; this says what to do about it), and the
-- owner, storage options and grants are carried to the new view exactly as
-- 000131 carries them (default-privilege grants on the new view are revoked,
-- then the old view's grants are granted). The DROP is written through
-- format() because the drift guard (scripts/tests/migration-drift.test.mjs)
-- rejects the literal statement in an allowlisted file: the rule it enforces
-- is "never rebuild on every deploy", which a catalog-guarded drop cannot do.
--
-- To apply it by hand ahead of a deploy, in a quiet window (not while
-- `shorted picks` or the financial-report-extractor is running):
--   task db:prod:apply FILE=services/migrations/000132_extend_fundamentals.up.sql CONFIRM=prod
-- prod-psql's classifier reads two BEGIN ... COMMIT pairs as `session`, which
-- is right: each transaction disarms its own statement_timeout with SET LOCAL.

-- ===========================================================================
-- Transaction 1: refresh_strategy_views() with the quality view (plan §2.8)
-- ===========================================================================
BEGIN;

SET LOCAL statement_timeout = 0;

-- The 000095 / 000130 guard pattern verbatim: every REFRESH in its own
-- BEGIN/EXCEPTION block, CONCURRENTLY first, a plain refresh as fallback, and
-- handlers that name query_canceled explicitly (plpgsql's WHEN OTHERS does not
-- match 57014, which a statement_timeout raises), so one failing view is a
-- WARNING 'Skipping <view>: ...' and never starves the next. Until transaction
-- 2 has built mv_fundamentals_quality, refreshing it warns 'Skipping
-- mv_fundamentals_quality', which the job treats as a failed run.
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

    -- ~2,300 codes x ~15 fundamentals rows, primary-key probes.
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

    -- The same table, three primary-key probes per code.
    RAISE NOTICE 'Refreshing mv_fundamentals_quality (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_fundamentals_quality;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_fundamentals_quality concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_fundamentals_quality;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_fundamentals_quality: %', SQLERRM;
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

-- Function-scoped GUC (000095 measured that it cannot disarm a timer the
-- CALLING command already armed, so the caller still sends SET LOCAL
-- statement_timeout = 0 first).
ALTER FUNCTION refresh_strategy_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_strategy_views() IS
    'Refreshes the stock-picker views cheapest-first (mv_market_regime, mv_fundamentals_growth, mv_fundamentals_quality, mv_price_features). Each refresh is individually guarded (concurrent, then non-concurrent fallback, then WARNING ''Skipping <view>''; handlers name query_canceled explicitly) so one failing view cannot starve the rest. Called by `shorted picks -mode refresh` after the daily price sweep.';

COMMIT;

-- ===========================================================================
-- Transaction 2: tables, columns and views, in refresh_strategy_views() order
-- ===========================================================================
BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- a. financial_report_extractions.document_meta (plan §2.5): what the
--    extractor read off the document itself (currency, units, entity, period,
--    report kind), from a closed vocabulary; anything else is treated as
--    absent by its readers. Nullable, written by the report extractor.
-- ---------------------------------------------------------------------------
DO $m132$
BEGIN
    IF to_regclass('financial_report_extractions') IS NULL THEN
        RAISE NOTICE 'financial_report_extractions does not exist here; document_meta not added';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema()
                     AND table_name = 'financial_report_extractions'
                     AND column_name = 'document_meta') THEN
        EXECUTE 'ALTER TABLE financial_report_extractions ADD COLUMN IF NOT EXISTS document_meta JSONB';
    END IF;
END
$m132$;

-- ---------------------------------------------------------------------------
-- b. picks_run_lease (plan §2.4, §3.8): single flight for `shorted picks`.
--    One row per lease name, claimed with INSERT ... ON CONFLICT DO UPDATE
--    WHERE expires_at < now(). No row is written here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS picks_run_lease (
    name       TEXT        PRIMARY KEY,
    holder     TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- c. The guarded DROP of mv_fundamentals_growth (plan §2.6). Only while the
--    view lacks revenue_prior_period_end, i.e. once, on the first apply.
-- ---------------------------------------------------------------------------
DO $m132$
DECLARE
    growth     oid := to_regclass('mv_fundamentals_growth');
    dependents text;
BEGIN
    IF growth IS NULL THEN
        RETURN;  -- nothing to rebuild; step e builds it
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = growth AND attname = 'revenue_prior_period_end' AND NOT attisdropped) THEN
        RETURN;  -- already this migration's definition: a replay
    END IF;

    -- Anything that depends on the view (another view's rewrite rule, a
    -- SQL-body function) stops the migration by name. Its own _RETURN rule,
    -- row type and indexes are internal/auto dependencies and go with it.
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

    -- What the rebuilt view must carry over (applied after step e's CREATE).
    CREATE TEMP TABLE _m132_growth_carry ON COMMIT DROP AS
    SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions, c.relacl
      FROM pg_class c
     WHERE c.oid = growth;

    EXECUTE format('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth');
END
$m132$;

-- ---------------------------------------------------------------------------
-- d. Column adds (plan §2.1, §2.3), then the v2 CHECK.
--
--    stock_fundamentals: the full statements in Yahoo's sign convention
--    (outflows NEGATIVE: capex, dividends paid and buybacks are <= 0, enforced
--    at write by the job). The balance columns are point-in-time positions at
--    period_end; period_type = 'quarter' rows are balance snapshots carrying
--    ONLY those (and shares_outstanding). total_debt INCLUDES lease
--    liabilities; net_debt is Yahoo's NetDebt, which EXCLUDES leases and is
--    omitted when <= 0. field_sources records only the fields whose value did
--    not come from the row's `source` ("markit-key-statistics",
--    "asx-filing-extraction", "derived:fcf-minus-capex", "derived:ttm-at-fye");
--    source_document_url / _date name the filing a row (or its filing-filled
--    fields) came from. field_sources' constant default is metadata-only
--    (no table rewrite).
--
--    stock_fundamentals_sync: last_outcome ('loaded' | 'empty' | 'failed'),
--    consecutive_empty (selection skips repeat empties) and median_k (the
--    identity-gate reference, read by valuation; NULL below 3 periods).
-- ---------------------------------------------------------------------------
DO $m132$
DECLARE
    col record;
BEGIN
    FOR col IN
        SELECT v.tbl, v.name, v.typ
          FROM (VALUES
            ('stock_fundamentals', 'gross_profit',              'DOUBLE PRECISION'),
            ('stock_fundamentals', 'operating_income',          'DOUBLE PRECISION'),
            ('stock_fundamentals', 'ebitda',                    'DOUBLE PRECISION'),
            ('stock_fundamentals', 'normalized_ebitda',         'DOUBLE PRECISION'),
            ('stock_fundamentals', 'ebit',                      'DOUBLE PRECISION'),
            ('stock_fundamentals', 'interest_expense',          'DOUBLE PRECISION'),
            ('stock_fundamentals', 'pretax_income',             'DOUBLE PRECISION'),
            ('stock_fundamentals', 'tax_provision',             'DOUBLE PRECISION'),
            ('stock_fundamentals', 'net_interest_income',       'DOUBLE PRECISION'),
            ('stock_fundamentals', 'capital_expenditure',       'DOUBLE PRECISION'),
            ('stock_fundamentals', 'dividends_paid',            'DOUBLE PRECISION'),
            ('stock_fundamentals', 'share_buybacks',            'DOUBLE PRECISION'),
            ('stock_fundamentals', 'total_assets',              'DOUBLE PRECISION'),
            ('stock_fundamentals', 'total_liabilities',         'DOUBLE PRECISION'),
            ('stock_fundamentals', 'total_equity',              'DOUBLE PRECISION'),
            ('stock_fundamentals', 'cash_and_equivalents',      'DOUBLE PRECISION'),
            ('stock_fundamentals', 'total_debt',                'DOUBLE PRECISION'),
            ('stock_fundamentals', 'capital_lease_obligations', 'DOUBLE PRECISION'),
            ('stock_fundamentals', 'net_debt',                  'DOUBLE PRECISION'),
            ('stock_fundamentals', 'current_assets',            'DOUBLE PRECISION'),
            ('stock_fundamentals', 'current_liabilities',       'DOUBLE PRECISION'),
            ('stock_fundamentals', 'field_sources',             'JSONB NOT NULL DEFAULT ''{}''::jsonb'),
            ('stock_fundamentals', 'source_document_url',       'TEXT'),
            ('stock_fundamentals', 'source_document_date',      'DATE'),
            ('stock_fundamentals_sync', 'last_outcome',         'VARCHAR(16)'),
            ('stock_fundamentals_sync', 'consecutive_empty',    'SMALLINT NOT NULL DEFAULT 0'),
            ('stock_fundamentals_sync', 'median_k',             'DOUBLE PRECISION')
          ) AS v(tbl, name, typ)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema()
                         AND table_name = col.tbl
                         AND column_name = col.name) THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I %s', col.tbl, col.name, col.typ);
        END IF;
    END LOOP;
END
$m132$;

-- Finite and plausible, or NULL, on every new numeric column: 000129's form
-- (NaN compares greater than every number in Postgres, so BETWEEN refuses NaN
-- and ±Infinity; the 1e-12 floor refuses denormal-scale values, the only way
-- a ratio in the views below could overflow). The job applies the identical
-- range before writing (picks/rows.go storable). Added NOT VALID, then
-- validated, each only when the catalog says it is needed.
DO $m132$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'stock_fundamentals'::regclass
                     AND conname = 'stock_fundamentals_finite_check_v2') THEN
        EXECUTE $check$
            ALTER TABLE stock_fundamentals ADD CONSTRAINT stock_fundamentals_finite_check_v2 CHECK (
                (gross_profit              IS NULL OR gross_profit = 0              OR abs(gross_profit)              BETWEEN 1e-12 AND 1e18) AND
                (operating_income          IS NULL OR operating_income = 0          OR abs(operating_income)          BETWEEN 1e-12 AND 1e18) AND
                (ebitda                    IS NULL OR ebitda = 0                    OR abs(ebitda)                    BETWEEN 1e-12 AND 1e18) AND
                (normalized_ebitda         IS NULL OR normalized_ebitda = 0         OR abs(normalized_ebitda)         BETWEEN 1e-12 AND 1e18) AND
                (ebit                      IS NULL OR ebit = 0                      OR abs(ebit)                      BETWEEN 1e-12 AND 1e18) AND
                (interest_expense          IS NULL OR interest_expense = 0          OR abs(interest_expense)          BETWEEN 1e-12 AND 1e18) AND
                (pretax_income             IS NULL OR pretax_income = 0             OR abs(pretax_income)             BETWEEN 1e-12 AND 1e18) AND
                (tax_provision             IS NULL OR tax_provision = 0             OR abs(tax_provision)             BETWEEN 1e-12 AND 1e18) AND
                (net_interest_income       IS NULL OR net_interest_income = 0       OR abs(net_interest_income)       BETWEEN 1e-12 AND 1e18) AND
                (capital_expenditure       IS NULL OR capital_expenditure = 0       OR abs(capital_expenditure)       BETWEEN 1e-12 AND 1e18) AND
                (dividends_paid            IS NULL OR dividends_paid = 0            OR abs(dividends_paid)            BETWEEN 1e-12 AND 1e18) AND
                (share_buybacks            IS NULL OR share_buybacks = 0            OR abs(share_buybacks)            BETWEEN 1e-12 AND 1e18) AND
                (total_assets              IS NULL OR total_assets = 0              OR abs(total_assets)              BETWEEN 1e-12 AND 1e18) AND
                (total_liabilities         IS NULL OR total_liabilities = 0         OR abs(total_liabilities)         BETWEEN 1e-12 AND 1e18) AND
                (total_equity              IS NULL OR total_equity = 0              OR abs(total_equity)              BETWEEN 1e-12 AND 1e18) AND
                (cash_and_equivalents      IS NULL OR cash_and_equivalents = 0      OR abs(cash_and_equivalents)      BETWEEN 1e-12 AND 1e18) AND
                (total_debt                IS NULL OR total_debt = 0                OR abs(total_debt)                BETWEEN 1e-12 AND 1e18) AND
                (capital_lease_obligations IS NULL OR capital_lease_obligations = 0 OR abs(capital_lease_obligations) BETWEEN 1e-12 AND 1e18) AND
                (net_debt                  IS NULL OR net_debt = 0                  OR abs(net_debt)                  BETWEEN 1e-12 AND 1e18) AND
                (current_assets            IS NULL OR current_assets = 0            OR abs(current_assets)            BETWEEN 1e-12 AND 1e18) AND
                (current_liabilities       IS NULL OR current_liabilities = 0       OR abs(current_liabilities)       BETWEEN 1e-12 AND 1e18)
            ) NOT VALID
        $check$;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = 'stock_fundamentals'::regclass
                 AND conname = 'stock_fundamentals_finite_check_v2'
                 AND NOT convalidated) THEN
        EXECUTE 'ALTER TABLE stock_fundamentals VALIDATE CONSTRAINT stock_fundamentals_finite_check_v2';
    END IF;
END
$m132$;

-- ---------------------------------------------------------------------------
-- e. mv_fundamentals_growth (plan §2.6). Every 000129 column keeps its name,
--    type, position and meaning; four are APPENDED: revenue_basis_source,
--    eps_basis_source ('vendor' | 'filing'; NULL when the basis has no latest
--    figure), revenue_latest_period_end and revenue_prior_period_end (the
--    ends of the pair revenue_yoy_pct used; NULL without that figure).
--
-- What changed against 000129:
--   LATERALS FILTER ON THE FIELD THEY READ. Annual revenue rows (a1/a0/am1)
--     need revenue, annual profit rows (n1/n0) net income, EPS rows their EPS
--     column, half rows (h1/h0/hm1) any of revenue / net income / EPS, TTM
--     rows (t1) revenue or net income. 'quarter' rows (balance snapshots) are
--     never read, and periods_available counts rows carrying any flow field.
--     So a balance-only or EPS-only row can never blank a growth figure.
--     net_income_latest / _prior / _positive and net_income_half_delta read
--     the profit series; operating_cash_flow_latest is the OCF on a1 (the row
--     latest_annual_period_end names); eps_ttm is the latest TTM diluted EPS.
--   FRESHER TTM REVENUE. When the latest TTM revenue point (tr1) is newer than
--     the latest annual revenue point (a1), and a comparator exists (the TTM
--     row 12 months +/- 7 days earlier, else the annual row 12 months +/- 7
--     days earlier; same currency, revenue > 0: rc), revenue uses tr1 vs rc
--     and revenue_basis_period_type = 'ttm'. revenue_yoy_prior_pct on that
--     basis is rc vs the point 12 months (+/- 7 days) before it (TTM else
--     annual: rp), else NULL (never the two-year-old annual acceleration).
--     The half basis still wins when the half is the newest point (strictly
--     newer than a1 and, on the TTM basis, than tr1: a TTM point on the half's
--     date is as fresh and smoother).
--   BASIS SOURCE. 'filing' when either row of the chosen pair has source
--     asx-filing-extraction, or the field the basis used (revenue, or the EPS
--     column the EPS basis used) is marked asx-filing-extraction in
--     field_sources on either row; else 'vendor'.
--
-- Every *_yoy_pct is still `CASE WHEN prior > 0 ...` (NULL unless the prior is
-- strictly positive and in the same currency), so nothing here can be
-- non-finite. Cost: ~2,300 codes x ~15 rows; every LATERAL is a primary-key
-- range probe (stock_code, period_type, period_end).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_growth AS
WITH codes AS (
    SELECT f.stock_code,
           count(*)::int              AS periods_available,
           max(f.source_fetched_at)   AS fetched_at
    FROM stock_fundamentals f
    WHERE f.period_type IN ('annual', 'half', 'ttm')
      AND num_nonnulls(f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.operating_cash_flow, f.free_cash_flow,
                       f.gross_profit, f.operating_income, f.ebitda, f.normalized_ebitda, f.ebit, f.interest_expense,
                       f.pretax_income, f.tax_provision, f.net_interest_income, f.capital_expenditure,
                       f.dividends_paid, f.share_buybacks) > 0
    GROUP BY f.stock_code
)
SELECT
    c.stock_code,
    CASE WHEN half_basis.eps THEN 'half' WHEN eps_ttm_ok.ok THEN 'ttm' ELSE 'annual' END::varchar(8) AS basis_period_type,
    CASE WHEN half_basis.eps THEN h1.period_end
         WHEN eps_ttm_ok.ok THEN e1.period_end
         ELSE COALESCE(ae1.period_end, a1.period_end, t1.period_end, h1.period_end) END AS latest_period_end,
    a1.period_end                                                          AS latest_annual_period_end,

    rb.latest                                                              AS revenue_latest,
    rb.prior                                                               AS revenue_prior,
    rb.yoy                                                                 AS revenue_yoy_pct,
    rb.yoy_prior                                                           AS revenue_yoy_prior_pct,

    eb.latest                                                              AS eps_latest,
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

    n1.net_income                                                          AS net_income_latest,
    n0.net_income                                                          AS net_income_prior,
    (n1.net_income > 0)                                                    AS net_income_positive,
    a1.operating_cash_flow                                                 AS operating_cash_flow_latest,

    t1.revenue                                                             AS revenue_ttm,
    t1.net_income                                                          AS net_income_ttm,
    e1.eps_diluted                                                         AS eps_ttm,

    CASE WHEN half_ok.rev THEN t1.revenue - a1.revenue END                 AS revenue_half_delta,
    CASE WHEN half_ok.ni THEN t1.net_income - n1.net_income END            AS net_income_half_delta,

    COALESCE(rb.currency, a1.currency, n1.currency, t1.currency, h1.currency, ae1.currency, e1.currency)::varchar(8) AS currency,
    c.periods_available,
    c.fetched_at,

    hg.revenue_yoy                                                         AS revenue_half_yoy_pct,
    hg.net_income_yoy                                                      AS net_income_half_yoy_pct,
    hg.eps_yoy                                                             AS eps_half_yoy_pct,
    h1.period_end                                                          AS half_latest_period_end,
    rb.basis::varchar(8)                                                   AS revenue_basis_period_type,

    -- Appended by 000132 (plan §2.6). revenue_prior_period_end stays LAST: it
    -- is the key the rebuild guard above looks for.
    CASE WHEN rb.latest IS NULL THEN NULL
         WHEN 'asx-filing-extraction' = ANY (rb.marks) THEN 'filing'
         ELSE 'vendor' END::varchar(8)                                     AS revenue_basis_source,
    CASE WHEN eb.latest IS NULL THEN NULL
         WHEN 'asx-filing-extraction' = ANY (eb.marks) THEN 'filing'
         ELSE 'vendor' END::varchar(8)                                     AS eps_basis_source,
    CASE WHEN rb.yoy IS NOT NULL THEN rb.latest_end END                    AS revenue_latest_period_end,
    CASE WHEN rb.yoy IS NOT NULL THEN rb.prior_end END                     AS revenue_prior_period_end
FROM codes c
-- Annual revenue rows (the annual revenue basis; OCF is read off a1).
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.operating_cash_flow, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.revenue IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) a1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.revenue IS NOT NULL
      AND f.period_end BETWEEN (a1.period_end - INTERVAL '14 months')::date
                           AND (a1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) a0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.revenue IS NOT NULL
      AND f.period_end BETWEEN (a0.period_end - INTERVAL '14 months')::date
                           AND (a0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) am1 ON true
-- Annual profit rows.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.net_income
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.net_income IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) n1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.net_income
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.net_income IS NOT NULL
      AND f.period_end BETWEEN (n1.period_end - INTERVAL '14 months')::date
                           AND (n1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) n0 ON true
-- Annual rows carrying a diluted EPS (the EPS fallback basis).
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'annual' AND f.eps_diluted IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) ae1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted, f.source, f.field_sources
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
-- TTM rows. t1 is the latest TTM revenue / profit point (revenue_ttm,
-- net_income_ttm, the half deltas); e1/e0/em1 the TTM diluted-EPS series.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm'
      AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL)
    ORDER BY f.period_end DESC
    LIMIT 1
) t1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm' AND f.eps_diluted IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) e1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.eps_diluted, f.source, f.field_sources
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
-- The TTM revenue basis: tr1 the latest TTM revenue point; rc its comparator
-- 12 months (+/- 7 days) earlier, a TTM row preferred to an annual one; rp the
-- point 12 months (+/- 7 days) before rc, on the same preference.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'ttm' AND f.revenue IS NOT NULL
    ORDER BY f.period_end DESC
    LIMIT 1
) tr1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type IN ('ttm', 'annual')
      AND f.revenue > 0 AND f.currency = tr1.currency
      AND f.period_end BETWEEN (tr1.period_end - INTERVAL '12 months' - INTERVAL '7 days')::date
                           AND (tr1.period_end - INTERVAL '12 months' + INTERVAL '7 days')::date
    ORDER BY (f.period_type = 'ttm') DESC,
             abs(f.period_end - (tr1.period_end - INTERVAL '12 months')::date),
             f.period_end DESC
    LIMIT 1
) rc ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type IN ('ttm', 'annual')
      AND f.revenue > 0 AND f.currency = rc.currency
      AND f.period_end BETWEEN (rc.period_end - INTERVAL '12 months' - INTERVAL '7 days')::date
                           AND (rc.period_end - INTERVAL '12 months' + INTERVAL '7 days')::date
    ORDER BY (f.period_type = 'ttm') DESC,
             abs(f.period_end - (rc.period_end - INTERVAL '12 months')::date),
             f.period_end DESC
    LIMIT 1
) rp ON true
-- Half rows (company filings). h1 is the latest half; h0 the same half a year
-- earlier; hm1 the one a year before that.
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
      AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL OR f.eps_diluted IS NOT NULL)
    ORDER BY f.period_end DESC
    LIMIT 1
) h1 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.source, f.field_sources
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
      AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL OR f.eps_diluted IS NOT NULL)
      AND f.period_end BETWEEN (h1.period_end - INTERVAL '14 months')::date
                           AND (h1.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) h0 ON true
LEFT JOIN LATERAL (
    SELECT f.period_end, f.currency, f.revenue, f.eps_basic, f.eps_diluted
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type = 'half'
      AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL OR f.eps_diluted IS NOT NULL)
      AND f.period_end BETWEEN (h0.period_end - INTERVAL '14 months')::date
                           AND (h0.period_end - INTERVAL '10 months')::date
    ORDER BY f.period_end DESC
    LIMIT 1
) hm1 ON true
-- Half EPS on ONE measure per pair: diluted when both halves carry it, else
-- basic (a filing usually quotes basic only). col names the column used.
CROSS JOIN LATERAL (
    SELECT CASE WHEN h1.eps_diluted IS NOT NULL AND h0.eps_diluted IS NOT NULL THEN h1.eps_diluted ELSE h1.eps_basic END   AS latest,
           CASE WHEN h1.eps_diluted IS NOT NULL AND h0.eps_diluted IS NOT NULL THEN h0.eps_diluted ELSE h0.eps_basic END   AS prior,
           CASE WHEN h0.eps_diluted IS NOT NULL AND hm1.eps_diluted IS NOT NULL THEN h0.eps_diluted ELSE h0.eps_basic END  AS prior_latest,
           CASE WHEN h0.eps_diluted IS NOT NULL AND hm1.eps_diluted IS NOT NULL THEN hm1.eps_diluted ELSE hm1.eps_basic END AS prior_prior,
           CASE WHEN h1.eps_diluted IS NOT NULL AND h0.eps_diluted IS NOT NULL THEN 'eps_diluted' ELSE 'eps_basic' END     AS col
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
-- the latest annual EPS.
CROSS JOIN LATERAL (
    SELECT (e1.period_end IS NOT NULL AND e0.period_end IS NOT NULL
            AND (ae1.period_end IS NULL OR e1.period_end >= ae1.period_end)) AS ok
) eps_ttm_ok
-- The TTM revenue basis applies when the latest TTM revenue point is STRICTLY
-- newer than the latest annual revenue point and has a comparator.
CROSS JOIN LATERAL (
    SELECT (tr1.period_end IS NOT NULL AND rc.period_end IS NOT NULL
            AND (a1.period_end IS NULL OR tr1.period_end > a1.period_end)) AS ok
) rev_ttm
-- The half basis applies per series when its half growth exists and the half
-- is STRICTLY newer than that series' vendor basis.
CROSS JOIN LATERAL (
    SELECT (hg.revenue_yoy IS NOT NULL
            AND (a1.period_end IS NULL OR h1.period_end > a1.period_end)
            AND (NOT rev_ttm.ok OR h1.period_end > tr1.period_end)) AS rev,
           (hg.eps_yoy IS NOT NULL
            AND (CASE WHEN eps_ttm_ok.ok THEN e1.period_end ELSE ae1.period_end END IS NULL
                 OR h1.period_end > CASE WHEN eps_ttm_ok.ok THEN e1.period_end ELSE ae1.period_end END)) AS eps
) half_basis
-- Half deltas (TTM - FY): only when the TTM point is 5-7 months after that
-- series' latest annual (i.e. it IS the first half after that year) and in
-- the same currency.
CROSS JOIN LATERAL (
    SELECT (t1.revenue IS NOT NULL AND a1.period_end IS NOT NULL
            AND t1.currency = a1.currency
            AND t1.period_end BETWEEN (a1.period_end + INTERVAL '5 months')::date
                                  AND (a1.period_end + INTERVAL '7 months')::date) AS rev,
           (t1.net_income IS NOT NULL AND n1.period_end IS NOT NULL
            AND t1.currency = n1.currency
            AND t1.period_end BETWEEN (n1.period_end + INTERVAL '5 months')::date
                                  AND (n1.period_end + INTERVAL '7 months')::date) AS ni
) half_ok
-- The revenue basis, as one set: latest / prior / growth / period ends /
-- currency / provenance marks never mix bases.
CROSS JOIN LATERAL (
    SELECT
        CASE WHEN half_basis.rev THEN 'half' WHEN rev_ttm.ok THEN 'ttm' ELSE 'annual' END AS basis,
        CASE WHEN half_basis.rev THEN h1.revenue WHEN rev_ttm.ok THEN tr1.revenue ELSE a1.revenue END AS latest,
        CASE WHEN half_basis.rev THEN h0.revenue WHEN rev_ttm.ok THEN rc.revenue ELSE a0.revenue END AS prior,
        CASE WHEN half_basis.rev THEN hg.revenue_yoy
             WHEN rev_ttm.ok THEN
                 CASE WHEN rc.revenue > 0 AND tr1.revenue IS NOT NULL AND tr1.currency = rc.currency
                      THEN (tr1.revenue - rc.revenue) / rc.revenue * 100 END
             ELSE
                 CASE WHEN a0.revenue > 0 AND a1.revenue IS NOT NULL AND a1.currency = a0.currency
                      THEN (a1.revenue - a0.revenue) / a0.revenue * 100 END
        END AS yoy,
        CASE WHEN half_basis.rev THEN hg.revenue_yoy_prior
             WHEN rev_ttm.ok THEN
                 CASE WHEN rp.revenue > 0 AND rc.revenue IS NOT NULL AND rc.currency = rp.currency
                      THEN (rc.revenue - rp.revenue) / rp.revenue * 100 END
             ELSE
                 CASE WHEN am1.revenue > 0 AND a0.revenue IS NOT NULL AND a0.currency = am1.currency
                      THEN (a0.revenue - am1.revenue) / am1.revenue * 100 END
        END AS yoy_prior,
        CASE WHEN half_basis.rev THEN h1.period_end WHEN rev_ttm.ok THEN tr1.period_end ELSE a1.period_end END AS latest_end,
        CASE WHEN half_basis.rev THEN h0.period_end WHEN rev_ttm.ok THEN rc.period_end ELSE a0.period_end END AS prior_end,
        CASE WHEN half_basis.rev THEN h1.currency WHEN rev_ttm.ok THEN tr1.currency ELSE a1.currency END AS currency,
        CASE WHEN half_basis.rev
             THEN ARRAY[h1.source, h0.source, h1.field_sources ->> 'revenue', h0.field_sources ->> 'revenue']
             WHEN rev_ttm.ok
             THEN ARRAY[tr1.source, rc.source, tr1.field_sources ->> 'revenue', rc.field_sources ->> 'revenue']
             ELSE ARRAY[a1.source, a0.source, a1.field_sources ->> 'revenue', a0.field_sources ->> 'revenue']
        END::text[] AS marks
) rb
-- The EPS basis's latest figure and provenance marks, on the column it used.
CROSS JOIN LATERAL (
    SELECT
        CASE WHEN half_basis.eps THEN he.latest
             WHEN eps_ttm_ok.ok THEN e1.eps_diluted ELSE ae1.eps_diluted END AS latest,
        CASE WHEN half_basis.eps
             THEN ARRAY[h1.source, h0.source, h1.field_sources ->> he.col, h0.field_sources ->> he.col]
             WHEN eps_ttm_ok.ok
             THEN ARRAY[e1.source, e0.source, e1.field_sources ->> 'eps_diluted', e0.field_sources ->> 'eps_diluted']
             ELSE ARRAY[ae1.source, ae0.source, ae1.field_sources ->> 'eps_diluted', ae0.field_sources ->> 'eps_diluted']
        END::text[] AS marks
) eb
WITH DATA;

-- REFRESH ... CONCURRENTLY needs a unique index on plain columns. Created only
-- when absent: CREATE UNIQUE INDEX IF NOT EXISTS would take a SHARE lock on the
-- view before noticing the index exists, on every replay. The owner, storage
-- options and grants of the dropped view (step c) are carried over here, and
-- the COMMENT is written only when it differs.
DO $m132$
DECLARE
    note  constant text := 'One row per stock with any flow row (quarter balance snapshots are never read). Revenue growth: annual vs prior annual, or the latest TTM revenue vs the TTM (else annual) point 12 months +/- 7 days earlier when the TTM is newer than the latest annual (revenue_basis_period_type = ttm), or the latest half vs the same half a year earlier when the half is newest (= half). EPS growth: TTM vs TTM a year earlier (else annual), or half when fresher (basis_period_type). revenue_basis_source / eps_basis_source say whether either row of the pair, or the field it used, came from a company filing (filing) or not (vendor); revenue_latest_period_end / revenue_prior_period_end are the ends of the pair revenue_yoy_pct used. Every lateral filters on the field it reads. Every *_yoy_pct is NULL unless the prior is > 0 and in the same currency. Refreshed by refresh_strategy_views().';
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
            -- The grants exactly as they were: first undo what default
            -- privileges granted the new view, then grant what the old one had.
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
        BEGIN
            EXECUTE format('COMMENT ON MATERIALIZED VIEW mv_fundamentals_growth IS %L', note);
        EXCEPTION WHEN lock_not_available THEN
            RAISE NOTICE 'mv_fundamentals_growth is locked (a refresh?); its COMMENT is left for the next deploy';
        END;
    END IF;
END
$m132$;

-- ---------------------------------------------------------------------------
-- f. mv_fundamentals_quality (plan §2.7): one row per stock with any flow row.
--    Reads stock_fundamentals ONLY (no prices, no company metadata), so it
--    never blocks a rebuild of another table or view.
--
--    FLOW BASIS (fb): the latest ttm or annual row with BOTH revenue and net
--      income; at equal period_end the row with more non-NULL flow fields
--      wins (then the annual). Every income / cash-flow line and every flow
--      ratio uses that ONE row.
--    BALANCE BASIS (bb): the annual, half or quarter row with total_equity and
--      the flow row's currency whose period_end equals the flow period_end,
--      else the latest such row dated no more than 6 months BEFORE it (never
--      after). Priors (bp: total_equity_prior, total_assets_prior) come from
--      the balance row 10-14 months before bb, the one closest to 12 months.
--      Any ratio mixing flow and balance fields is NULL when no balance row
--      qualifies; balance_lag_months records the gap in calendar months.
--
--    Definitions (every division is `CASE WHEN denominator > 0`):
--      net_debt = the stored net_debt (Yahoo's, excluding leases), else
--        total_debt - capital_lease_obligations - cash_and_equivalents when
--        all three exist on the balance row (negative = net cash), else NULL.
--        Never total_debt - cash: total_debt includes lease liabilities.
--      margins = line / revenue (%). fcf_conversion = FCF / net income, NI > 0.
--      roe_pct / roa_pct: net income over the AVERAGE of the two balance
--        points, NULL unless both points exist and are > 0 (no single-point
--        fallback); roe_pct also NULL (not meaningful) when average equity is
--        below 10% of average assets, or when the assets are not known.
--      net_debt_to_ebitda = net_debt / COALESCE(normalized_ebitda, ebitda),
--        NULL when that denominator <= 0; net_debt_to_equity NULL when
--        equity <= 0.
--      interest_cover = operating_income / interest_expense (interest > 0);
--        current_ratio = current assets / current liabilities.
--      payout_ratio_pct = cash dividends paid / net profit: -dividends_paid /
--        net income, NULL when dividends_paid > 0 or NI <= 0.
--      statement_is_financial: operating_income AND ebitda both NULL on the
--        flow row (NULL without a flow row). Which ratios are not meaningful
--        for financials is decided in Go, once (services/shorts).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_quality AS
WITH codes AS (
    SELECT DISTINCT f.stock_code
    FROM stock_fundamentals f
    WHERE f.period_type IN ('annual', 'half', 'ttm')
      AND num_nonnulls(f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.operating_cash_flow, f.free_cash_flow,
                       f.gross_profit, f.operating_income, f.ebitda, f.normalized_ebitda, f.ebit, f.interest_expense,
                       f.pretax_income, f.tax_provision, f.net_interest_income, f.capital_expenditure,
                       f.dividends_paid, f.share_buybacks) > 0
)
SELECT
    c.stock_code,
    fb.period_type                                                         AS basis_period_type,
    fb.period_end                                                          AS basis_period_end,
    fb.currency,
    fb.source,
    fb.source_fetched_at                                                   AS fetched_at,
    fb.revenue,
    fb.gross_profit,
    fb.operating_income,
    fb.ebitda,
    fb.normalized_ebitda,
    fb.ebit,
    fb.net_income,
    fb.operating_cash_flow,
    (fb.operating_cash_flow IS NOT NULL
     AND COALESCE(fb.field_sources ->> 'operating_cash_flow', '') = 'derived:fcf-minus-capex') AS operating_cash_flow_derived,
    fb.free_cash_flow,
    fb.capital_expenditure,
    fb.dividends_paid,
    fb.interest_expense,
    fb.shares_outstanding,
    bb.period_end                                                          AS balance_period_end,
    bb.period_type                                                         AS balance_period_type,
    bb.currency                                                            AS balance_currency,
    CASE WHEN bb.period_end IS NOT NULL
         THEN ((extract(year FROM fb.period_end) * 12 + extract(month FROM fb.period_end))
             - (extract(year FROM bb.period_end) * 12 + extract(month FROM bb.period_end)))::int
    END                                                                    AS balance_lag_months,
    bb.total_assets,
    bp.total_assets                                                        AS total_assets_prior,
    bb.total_liabilities,
    bb.total_equity,
    bp.total_equity                                                        AS total_equity_prior,
    bb.cash_and_equivalents,
    bb.total_debt,
    bb.capital_lease_obligations,
    x.net_debt,
    bb.current_assets,
    bb.current_liabilities,
    CASE WHEN fb.revenue > 0 THEN fb.gross_profit / fb.revenue * 100 END          AS gross_margin_pct,
    CASE WHEN fb.revenue > 0 THEN fb.operating_income / fb.revenue * 100 END      AS operating_margin_pct,
    CASE WHEN fb.revenue > 0 THEN fb.net_income / fb.revenue * 100 END            AS net_margin_pct,
    CASE WHEN fb.revenue > 0 THEN fb.free_cash_flow / fb.revenue * 100 END        AS fcf_margin_pct,
    CASE WHEN fb.net_income > 0 THEN fb.free_cash_flow / fb.net_income END        AS fcf_conversion,
    CASE WHEN x.avg_equity > 0 AND x.avg_assets > 0 AND x.avg_equity >= 0.1 * x.avg_assets
         THEN fb.net_income / x.avg_equity * 100 END                              AS roe_pct,
    CASE WHEN x.avg_assets > 0 THEN fb.net_income / x.avg_assets * 100 END        AS roa_pct,
    CASE WHEN x.ebitda_basis > 0 THEN x.net_debt / x.ebitda_basis END             AS net_debt_to_ebitda,
    CASE WHEN bb.total_equity > 0 THEN x.net_debt / bb.total_equity END           AS net_debt_to_equity,
    CASE WHEN bb.current_liabilities > 0 THEN bb.current_assets / bb.current_liabilities END AS current_ratio,
    CASE WHEN fb.interest_expense > 0 THEN fb.operating_income / fb.interest_expense END    AS interest_cover,
    CASE WHEN fb.net_income > 0 AND fb.dividends_paid <= 0
         THEN abs(fb.dividends_paid) / fb.net_income * 100 END                    AS payout_ratio_pct,
    CASE WHEN fb.period_end IS NOT NULL
         THEN (fb.operating_income IS NULL AND fb.ebitda IS NULL) END             AS statement_is_financial
FROM codes c
-- Flow basis: one row, the freshest ttm/annual row with revenue AND profit.
LEFT JOIN LATERAL (
    SELECT f.period_type, f.period_end, f.currency, f.source, f.source_fetched_at, f.field_sources,
           f.revenue, f.gross_profit, f.operating_income, f.ebitda, f.normalized_ebitda, f.ebit, f.net_income,
           f.operating_cash_flow, f.free_cash_flow, f.capital_expenditure, f.dividends_paid, f.interest_expense,
           f.shares_outstanding
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type IN ('ttm', 'annual')
      AND f.revenue IS NOT NULL AND f.net_income IS NOT NULL
    ORDER BY f.period_end DESC,
             num_nonnulls(f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.operating_cash_flow, f.free_cash_flow,
                          f.gross_profit, f.operating_income, f.ebitda, f.normalized_ebitda, f.ebit, f.interest_expense,
                          f.pretax_income, f.tax_provision, f.net_interest_income, f.capital_expenditure,
                          f.dividends_paid, f.share_buybacks) DESC,
             (f.period_type = 'annual') DESC
    LIMIT 1
) fb ON true
-- Balance basis: same currency, on the flow date or up to 6 months before it.
LEFT JOIN LATERAL (
    SELECT f.period_type, f.period_end, f.currency, f.total_assets, f.total_liabilities, f.total_equity,
           f.cash_and_equivalents, f.total_debt, f.capital_lease_obligations, f.net_debt,
           f.current_assets, f.current_liabilities
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type IN ('annual', 'half', 'quarter')
      AND f.total_equity IS NOT NULL AND f.currency = fb.currency
      AND f.period_end <= fb.period_end
      AND f.period_end >= (fb.period_end - INTERVAL '6 months')::date
    ORDER BY f.period_end DESC,
             num_nonnulls(f.total_assets, f.total_liabilities, f.total_equity, f.cash_and_equivalents, f.total_debt,
                          f.capital_lease_obligations, f.net_debt, f.current_assets, f.current_liabilities) DESC,
             CASE f.period_type WHEN 'annual' THEN 0 WHEN 'half' THEN 1 ELSE 2 END
    LIMIT 1
) bb ON true
-- The balance row a year before bb (10-14 months, closest to 12).
LEFT JOIN LATERAL (
    SELECT f.period_end, f.total_assets, f.total_equity
    FROM stock_fundamentals f
    WHERE f.stock_code = c.stock_code AND f.period_type IN ('annual', 'half', 'quarter')
      AND f.total_equity IS NOT NULL AND f.currency = bb.currency
      AND f.period_end BETWEEN (bb.period_end - INTERVAL '14 months')::date
                           AND (bb.period_end - INTERVAL '10 months')::date
    ORDER BY abs(f.period_end - (bb.period_end - INTERVAL '12 months')::date),
             f.period_end DESC,
             num_nonnulls(f.total_assets, f.total_equity) DESC,
             CASE f.period_type WHEN 'annual' THEN 0 WHEN 'half' THEN 1 ELSE 2 END
    LIMIT 1
) bp ON true
-- Derived inputs, each NULL rather than guessed.
CROSS JOIN LATERAL (
    SELECT
        COALESCE(bb.net_debt, bb.total_debt - bb.capital_lease_obligations - bb.cash_and_equivalents) AS net_debt,
        COALESCE(fb.normalized_ebitda, fb.ebitda)                                                      AS ebitda_basis,
        CASE WHEN bb.total_equity > 0 AND bp.total_equity > 0
             THEN (bb.total_equity + bp.total_equity) / 2 END                                          AS avg_equity,
        CASE WHEN bb.total_assets > 0 AND bp.total_assets > 0
             THEN (bb.total_assets + bp.total_assets) / 2 END                                          AS avg_assets
) x
WITH DATA;

DO $m132$
DECLARE
    note constant text := 'One row per stock with any flow row: margins, ROE / ROA, FCF conversion, net debt (excl. leases), leverage, liquidity, interest cover and cash payout, all in the REPORTING currency. Flow figures come from ONE row (the latest ttm or annual row with revenue and net income); balance figures from ONE row of the same currency dated on it or up to 6 months before it (balance_lag_months), with priors 10-14 months before that. Every ratio is NULL rather than guessed: divisions need a positive denominator, ROE / ROA need both balance points > 0, ROE is NULL below 10% equity / assets. statement_is_financial flags a flow row with neither operating income nor EBITDA. Reads stock_fundamentals only. Refreshed by refresh_strategy_views().';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = current_schema()
                     AND tablename = 'mv_fundamentals_quality'
                     AND indexname = 'idx_mv_fundamentals_quality_stock_code') THEN
        EXECUTE 'CREATE UNIQUE INDEX idx_mv_fundamentals_quality_stock_code ON mv_fundamentals_quality (stock_code)';
    END IF;

    IF obj_description('mv_fundamentals_quality'::regclass, 'pg_class') IS DISTINCT FROM note THEN
        BEGIN
            EXECUTE format('COMMENT ON MATERIALIZED VIEW mv_fundamentals_quality IS %L', note);
        EXCEPTION WHEN lock_not_available THEN
            RAISE NOTICE 'mv_fundamentals_quality is locked (a refresh?); its COMMENT is left for the next deploy';
        END;
    END IF;
END
$m132$;

COMMIT;
