-- Reverse 000106.
--
-- The candidate returns resolved by the Senate rule are RELEASED first: the
-- pre-000106 CHECK does not know 'state_surname_given_exact', and a constraint
-- that cannot be re-added leaves the table without one. Releasing sets both the
-- join and its method back together, because 000105's paired CHECK (and its
-- trigger) refuse a method without a politician_id and a politician_id without
-- a method.
--
-- The identity rows and Senate terms that register-senators minted are NOT
-- removed. They are facts from an official publication, slugs are minted once,
-- and a down migration that deletes people would make those slugs unmintable
-- again from the same source.

BEGIN;

UPDATE aec_candidate_returns
SET politician_id = NULL, resolution_method = 'unresolved'
WHERE resolution_method = 'state_surname_given_exact';

ALTER TABLE aec_candidate_returns
    DROP CONSTRAINT IF EXISTS aec_candidate_returns_resolution_check;
ALTER TABLE aec_candidate_returns
    ADD CONSTRAINT aec_candidate_returns_resolution_check
    CHECK (resolution_method IN (
        'unresolved', 'curated_alias', 'division_surname_given_exact'));

DROP FUNCTION IF EXISTS aec_state_full_name(TEXT);

DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_monthly;
DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_rollup;
DROP MATERIALIZED VIEW IF EXISTS mv_register_public_holdings;

CREATE MATERIALIZED VIEW mv_register_public_holdings AS
WITH latest_term AS (
    SELECT DISTINCT ON (politician_id)
        politician_id, parliament, chamber, division, state_code, party, party_ab
    FROM politician_terms
    ORDER BY politician_id, parliament DESC
)
SELECT hp.politician_id,
    p.display_name,
    p.slug,
    p.aph_mpid,
    t.chamber,
    t.division,
    t.state_code AS member_state,
    t.party,
    t.party_ab,
    hp.item_no,
    hp.holder,
    hp.declared_text,
    hp.secondary_text,
    hp.stock_code,
    hp.entity_kind,
    cm.company_name,
    cm.industry,
    hp.sal_code,
    sd.sal_name,
    sd.state_code AS property_state,
    hp.declared_from,
    hp.declared_from_known,
    hp.declared_to,
    hp.declared_to IS NULL AS currently_declared,
    hp.source_url,
    hp.source_licence,
    now() AS refreshed_at
FROM register_holding_periods hp
    JOIN politicians p ON p.id = hp.politician_id AND p.merged_into_id IS NULL
    LEFT JOIN latest_term t ON t.politician_id = hp.politician_id
    LEFT JOIN "company-metadata" cm ON cm.stock_code = hp.stock_code::text
    LEFT JOIN suburb_demographics sd ON sd.sal_code = hp.sal_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_public_holdings
    ON mv_register_public_holdings
    (politician_id, item_no, holder, declared_text, declared_from);
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_stock
    ON mv_register_public_holdings (stock_code) WHERE stock_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_sal
    ON mv_register_public_holdings (sal_code) WHERE sal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_slug
    ON mv_register_public_holdings (slug);

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
        -- Properties are DECLARED REAL-ESTATE ENTRIES (item 3), not resolved
        -- suburbs. Only a minority of item-3 rows carry a sal_code, so counting
        -- distinct sal_code reported the resolver's luck as the member's
        -- holdings ("0 properties" for a member declaring 13). This is the same
        -- shape mv_register_suburb_property (000096) counts with.
        count(*) FILTER (WHERE item_no = 3 AND currently_declared)::INTEGER AS property_count,
        -- All-time distinct counts, kept byte-for-byte identical to the
        -- politicianSelect projection in postgres_politicians.go so that
        -- Politician.declared_listed_count / declared_property_count carry the
        -- same number no matter which rpc served the row.
        count(DISTINCT stock_code) FILTER (WHERE stock_code IS NOT NULL)::INTEGER AS alltime_company_count,
        count(DISTINCT sal_code) FILTER (WHERE sal_code IS NOT NULL)::INTEGER AS alltime_suburb_count,
        count(*) FILTER (WHERE currently_declared AND item_no IN (11, 12))::INTEGER AS gifts_travel_count,
        count(*) FILTER (WHERE currently_declared AND item_no = 6)::INTEGER AS liability_count,
        -- NO changes_90d_count HERE, DELIBERATELY. A `CURRENT_DATE - 90` window
        -- materialised into this view freezes its clock at REFRESH time, while
        -- the two surfaces rendered beside it -- the hub's 7d/30d activity strip
        -- (GetRegisterExplorer) and a member's recent-changes list
        -- (loadRecentRegisterChanges) -- both evaluate CURRENT_DATE at QUERY
        -- time. The same page then disagrees with itself by one day for every
        -- day the refresh is late: a member can show "0 changes in 90 days" in
        -- the table while their own profile lists a change from last week.
        -- Per-member changes-90d is therefore computed LIVE, in
        -- politicianSummarySelect, from the same event definition the strip uses
        -- (a dated declared_from is one event; a declared_to is another), so all
        -- three windows read one clock. It costs ~11ms over the whole corpus.
        --
        -- The rest of this view is legitimately snapshot-shaped: those measures
        -- describe the holdings as extracted, and carry no window at all.
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
    COALESCE(h.alltime_company_count, 0)::INTEGER AS alltime_company_count,
    COALESCE(h.alltime_suburb_count, 0)::INTEGER AS alltime_suburb_count,
    COALESCE(h.gifts_travel_count, 0)::INTEGER AS gifts_travel_count,
    COALESCE(h.liability_count, 0)::INTEGER AS liability_count,
    COALESCE(h.undated_count, 0)::INTEGER AS undated_count,
    h.refreshed_at
FROM live_people p
LEFT JOIN holding_counts h ON h.politician_id = p.politician_id;

CREATE UNIQUE INDEX idx_mv_register_politician_rollup
    ON mv_register_politician_rollup (politician_id);

-- The month grid is anchored to CURRENT_DATE at REFRESH time, so the newest
-- month in this view is the refresh date, not today. Readers must therefore
-- window on `max(month)` FROM THIS VIEW rather than on wall-clock CURRENT_DATE:
-- a query-time CURRENT_DATE window silently shortens (and eventually empties)
-- the sparkline as the snapshot ages, while the tiles beside it keep showing
-- data from the rollup.
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

COMMIT;
