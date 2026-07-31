-- Register explorer rollups. Every holding aggregate below is derived from the
-- public holdings snapshot, so the publication gates are inherited before any
-- count reaches an explorer response.

CREATE MATERIALIZED VIEW mv_register_politician_rollup AS
WITH holding_counts AS (
    SELECT
        politician_id,
        slug,
        count(*) FILTER (WHERE item_no = 1 AND currently_declared)::INTEGER AS item_1_current_count,
        count(*) FILTER (WHERE item_no = 2 AND currently_declared)::INTEGER AS item_2_current_count,
        count(*) FILTER (WHERE item_no = 3 AND currently_declared)::INTEGER AS item_3_current_count,
        count(*) FILTER (WHERE item_no = 4 AND currently_declared)::INTEGER AS item_4_current_count,
        count(*) FILTER (WHERE item_no = 5 AND currently_declared)::INTEGER AS item_5_current_count,
        count(*) FILTER (WHERE item_no = 6 AND currently_declared)::INTEGER AS item_6_current_count,
        count(*) FILTER (WHERE item_no = 7 AND currently_declared)::INTEGER AS item_7_current_count,
        count(*) FILTER (WHERE item_no = 8 AND currently_declared)::INTEGER AS item_8_current_count,
        count(*) FILTER (WHERE item_no = 9 AND currently_declared)::INTEGER AS item_9_current_count,
        count(*) FILTER (WHERE item_no = 10 AND currently_declared)::INTEGER AS item_10_current_count,
        count(*) FILTER (WHERE item_no = 11 AND currently_declared)::INTEGER AS item_11_current_count,
        count(*) FILTER (WHERE item_no = 12 AND currently_declared)::INTEGER AS item_12_current_count,
        count(*) FILTER (WHERE item_no = 13 AND currently_declared)::INTEGER AS item_13_current_count,
        count(*) FILTER (WHERE item_no = 14 AND currently_declared)::INTEGER AS item_14_current_count,
        count(*) FILTER (WHERE item_no = 1)::INTEGER AS item_1_all_time_count,
        count(*) FILTER (WHERE item_no = 2)::INTEGER AS item_2_all_time_count,
        count(*) FILTER (WHERE item_no = 3)::INTEGER AS item_3_all_time_count,
        count(*) FILTER (WHERE item_no = 4)::INTEGER AS item_4_all_time_count,
        count(*) FILTER (WHERE item_no = 5)::INTEGER AS item_5_all_time_count,
        count(*) FILTER (WHERE item_no = 6)::INTEGER AS item_6_all_time_count,
        count(*) FILTER (WHERE item_no = 7)::INTEGER AS item_7_all_time_count,
        count(*) FILTER (WHERE item_no = 8)::INTEGER AS item_8_all_time_count,
        count(*) FILTER (WHERE item_no = 9)::INTEGER AS item_9_all_time_count,
        count(*) FILTER (WHERE item_no = 10)::INTEGER AS item_10_all_time_count,
        count(*) FILTER (WHERE item_no = 11)::INTEGER AS item_11_all_time_count,
        count(*) FILTER (WHERE item_no = 12)::INTEGER AS item_12_all_time_count,
        count(*) FILTER (WHERE item_no = 13)::INTEGER AS item_13_all_time_count,
        count(*) FILTER (WHERE item_no = 14)::INTEGER AS item_14_all_time_count,
        count(*) FILTER (WHERE holder = 'self' AND currently_declared)::INTEGER AS self_current_count,
        count(*) FILTER (WHERE holder = 'spouse_partner' AND currently_declared)::INTEGER AS spouse_partner_current_count,
        count(*) FILTER (WHERE holder = 'dependent_children' AND currently_declared)::INTEGER AS dependent_children_current_count,
        count(*) FILTER (WHERE holder = 'unspecified' AND currently_declared)::INTEGER AS unspecified_current_count,
        count(DISTINCT stock_code) FILTER (WHERE currently_declared AND stock_code IS NOT NULL)::INTEGER AS distinct_company_count,
        count(DISTINCT sal_code) FILTER (WHERE currently_declared AND sal_code IS NOT NULL)::INTEGER AS property_count,
        count(*) FILTER (WHERE currently_declared AND item_no IN (11, 12))::INTEGER AS gifts_travel_count,
        count(*) FILTER (WHERE currently_declared AND item_no = 6)::INTEGER AS liability_count,
        (
            count(*) FILTER (
                WHERE declared_from_known
                  AND declared_from >= CURRENT_DATE - 90
            )
            + count(*) FILTER (
                WHERE declared_to IS NOT NULL
                  AND declared_to >= CURRENT_DATE - 90
            )
        )::INTEGER AS changes_90d_count,
        count(*) FILTER (WHERE currently_declared AND NOT declared_from_known)::INTEGER AS undated_count,
        max(refreshed_at) AS refreshed_at
    FROM mv_register_public_holdings
    GROUP BY politician_id, slug
),
live_people AS (
    SELECT id AS politician_id, slug
    FROM politicians
    WHERE merged_into_id IS NULL
)
SELECT
    p.politician_id,
    p.slug,
    COALESCE(h.item_1_current_count, 0)::INTEGER AS item_1_current_count,
    COALESCE(h.item_2_current_count, 0)::INTEGER AS item_2_current_count,
    COALESCE(h.item_3_current_count, 0)::INTEGER AS item_3_current_count,
    COALESCE(h.item_4_current_count, 0)::INTEGER AS item_4_current_count,
    COALESCE(h.item_5_current_count, 0)::INTEGER AS item_5_current_count,
    COALESCE(h.item_6_current_count, 0)::INTEGER AS item_6_current_count,
    COALESCE(h.item_7_current_count, 0)::INTEGER AS item_7_current_count,
    COALESCE(h.item_8_current_count, 0)::INTEGER AS item_8_current_count,
    COALESCE(h.item_9_current_count, 0)::INTEGER AS item_9_current_count,
    COALESCE(h.item_10_current_count, 0)::INTEGER AS item_10_current_count,
    COALESCE(h.item_11_current_count, 0)::INTEGER AS item_11_current_count,
    COALESCE(h.item_12_current_count, 0)::INTEGER AS item_12_current_count,
    COALESCE(h.item_13_current_count, 0)::INTEGER AS item_13_current_count,
    COALESCE(h.item_14_current_count, 0)::INTEGER AS item_14_current_count,
    COALESCE(h.item_1_all_time_count, 0)::INTEGER AS item_1_all_time_count,
    COALESCE(h.item_2_all_time_count, 0)::INTEGER AS item_2_all_time_count,
    COALESCE(h.item_3_all_time_count, 0)::INTEGER AS item_3_all_time_count,
    COALESCE(h.item_4_all_time_count, 0)::INTEGER AS item_4_all_time_count,
    COALESCE(h.item_5_all_time_count, 0)::INTEGER AS item_5_all_time_count,
    COALESCE(h.item_6_all_time_count, 0)::INTEGER AS item_6_all_time_count,
    COALESCE(h.item_7_all_time_count, 0)::INTEGER AS item_7_all_time_count,
    COALESCE(h.item_8_all_time_count, 0)::INTEGER AS item_8_all_time_count,
    COALESCE(h.item_9_all_time_count, 0)::INTEGER AS item_9_all_time_count,
    COALESCE(h.item_10_all_time_count, 0)::INTEGER AS item_10_all_time_count,
    COALESCE(h.item_11_all_time_count, 0)::INTEGER AS item_11_all_time_count,
    COALESCE(h.item_12_all_time_count, 0)::INTEGER AS item_12_all_time_count,
    COALESCE(h.item_13_all_time_count, 0)::INTEGER AS item_13_all_time_count,
    COALESCE(h.item_14_all_time_count, 0)::INTEGER AS item_14_all_time_count,
    COALESCE(h.self_current_count, 0)::INTEGER AS self_current_count,
    COALESCE(h.spouse_partner_current_count, 0)::INTEGER AS spouse_partner_current_count,
    COALESCE(h.dependent_children_current_count, 0)::INTEGER AS dependent_children_current_count,
    COALESCE(h.unspecified_current_count, 0)::INTEGER AS unspecified_current_count,
    COALESCE(h.distinct_company_count, 0)::INTEGER AS distinct_company_count,
    COALESCE(h.property_count, 0)::INTEGER AS property_count,
    COALESCE(h.gifts_travel_count, 0)::INTEGER AS gifts_travel_count,
    COALESCE(h.liability_count, 0)::INTEGER AS liability_count,
    COALESCE(h.changes_90d_count, 0)::INTEGER AS changes_90d_count,
    COALESCE(h.undated_count, 0)::INTEGER AS undated_count,
    h.refreshed_at
FROM live_people p
LEFT JOIN holding_counts h ON h.politician_id = p.politician_id;

CREATE UNIQUE INDEX idx_mv_register_politician_rollup
    ON mv_register_politician_rollup (politician_id);

CREATE MATERIALIZED VIEW mv_register_politician_monthly AS
WITH months AS (
    SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - INTERVAL '59 months',
        date_trunc('month', CURRENT_DATE),
        INTERVAL '1 month'
    )::DATE AS month
),
live_people AS (
    SELECT id AS politician_id
    FROM politicians
    WHERE merged_into_id IS NULL
)
SELECT
    p.politician_id,
    m.month,
    (
        SELECT count(*)::INTEGER
        FROM mv_register_public_holdings h
        WHERE h.politician_id = p.politician_id
          AND h.declared_from_known
          AND h.declared_from <= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
          AND (h.declared_to IS NULL OR h.declared_to > (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE)
    ) AS declared_count
FROM live_people p
CROSS JOIN months m;

CREATE UNIQUE INDEX idx_mv_register_politician_monthly
    ON mv_register_politician_monthly (politician_id, month);

CREATE OR REPLACE FUNCTION refresh_register_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_register_suburb_property (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_suburb_property;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_suburb_property concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_suburb_property;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_suburb_property: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_register_public_holdings (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_public_holdings;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_public_holdings concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_public_holdings;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_public_holdings: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_register_politician_rollup (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_politician_rollup;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_politician_rollup concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_politician_rollup;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_politician_rollup: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_register_politician_monthly (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_politician_monthly;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_politician_monthly concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_politician_monthly;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_politician_monthly: %', SQLERRM;
    END;
END;
$$;

ALTER FUNCTION refresh_register_materialized_views() SET statement_timeout TO '0';
