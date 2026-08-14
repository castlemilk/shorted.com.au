-- Harden refresh_all_materialized_views() against partial-refresh starvation.
--
-- WHY: the nightly short-data-sync calls this function. Since ~2026-07-07 every
-- run died at `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data` with
-- "canceling statement due to statement timeout" (the Supabase role-level
-- statement_timeout; the sync's SQLAlchemy session never surfaced the error).
-- Statements BEFORE the failure had already committed their own refreshes, so
-- mv_top_shorts / mv_treemap_data / mv_watchlist_defaults stayed fresh while
-- everything AFTER the failing statement (mv_screener_data, mv_available_dates,
-- mv_short_campaigns, mv_stock_price_coverage, mv_company_state_exposure) went
-- stale for 19 days — silently degrading /statistics, /scans/* and /screener.
--
-- Two fixes:
--   1. Every REFRESH is wrapped in its own BEGIN/EXCEPTION block (the pattern
--      000027 already used for mv_treemap_data/mv_screener_data). A concurrent
--      refresh that fails retries non-concurrently; if THAT fails too, an outer
--      guard downgrades it to a WARNING. No single MV can abort the function or
--      starve the MVs after it.
--
--      The handlers name `query_canceled` EXPLICITLY. This is load-bearing:
--      plpgsql's `WHEN OTHERS` deliberately does NOT match query_canceled
--      (57014), which is exactly the error a statement_timeout raises — a plain
--      `WHEN OTHERS` guard would NOT have caught the prod failure. Verified
--      locally on PG (SET statement_timeout='1s' + pg_sleep inside a function:
--      OTHERS propagates, `query_canceled OR OTHERS` catches and continues).
--      Trade-off: an operator pg_cancel_backend() during a refresh is also
--      downgraded to a WARNING and the function proceeds to the next view; use
--      pg_terminate_backend() to stop it hard.
--
--      Once the timeout has fired and been caught, the timer is not re-armed for
--      the remainder of the call, so at worst ONE view is sacrificed and every
--      view after it still refreshes (also verified locally).
--
--   2. `ALTER FUNCTION ... SET statement_timeout TO '0'` (function-scoped GUC,
--      restored on return). CAVEAT, measured not assumed: this does NOT by
--      itself exempt the body. statement_timeout is armed once, when the client
--      command that calls the function starts; changing the GUC at function
--      entry does not disarm the already-scheduled timer, so a role-level
--      timeout still fires mid-body. It is kept because it is correct for any
--      caller that starts a fresh command inside the function's scope and it
--      costs nothing — but fix (1) is what actually saves the nightly run.
--      The durable caller-side fix is for short-data-sync to issue
--      `SET statement_timeout = 0` on its session before calling this function.
--
-- Ordering: cheap MVs first, expensive ones last. mv_available_dates is tiny but
-- was sequenced AFTER mv_screener_data, which is exactly why it was hostage to
-- the screener timeout.

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Cheap MVs first: they must never be blocked by an expensive refresh.
    RAISE NOTICE 'Refreshing mv_top_shorts (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_top_shorts concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_top_shorts;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_top_shorts: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_treemap_data (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_treemap_data concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_treemap_data;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_treemap_data: %', SQLERRM;
    END;

    -- mv_watchlist_defaults has no unique index: non-concurrent by design.
    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    BEGIN
        REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_watchlist_defaults: %', SQLERRM;
    END;

    -- Moved UP from after mv_screener_data: tiny view, and the read paths that
    -- depend on it (available dates for every date-scoped query) must not be
    -- collateral damage of a screener refresh failure.
    RAISE NOTICE 'Refreshing mv_available_dates (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_available_dates;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_available_dates concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_available_dates;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_available_dates: %', SQLERRM;
    END;

    -- Expensive MVs last.
    RAISE NOTICE 'Refreshing mv_screener_data (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_screener_data concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_screener_data;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_screener_data: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_short_campaigns (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_short_campaigns;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_short_campaigns concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_short_campaigns;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_short_campaigns: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_stock_price_coverage (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_stock_price_coverage concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_stock_price_coverage;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_stock_price_coverage: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_company_state_exposure (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_company_state_exposure;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_company_state_exposure concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_company_state_exposure;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_company_state_exposure: %', SQLERRM;
    END;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$;

-- Function-scoped GUC (see caveat in the header comment: it does not disarm a
-- timer already armed by the calling command, so it is a belt-and-braces
-- measure, not the primary fix).
ALTER FUNCTION refresh_all_materialized_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_all_materialized_views() IS
    'Refreshes all UI-facing materialized views cheapest-first. Every refresh is individually guarded (concurrent, then non-concurrent fallback, then WARNING; handlers name query_canceled explicitly so statement_timeout cancellations are caught) so one failing view cannot starve the rest.';
