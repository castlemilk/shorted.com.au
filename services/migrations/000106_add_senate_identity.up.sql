-- Senate identity reaches the published surface.
--
-- Two changes, both consequences of register-senators minting the first
-- politicians rows that were never produced by a lodged register document.
--
-- 1. mv_register_public_holdings picks ONE term per person to label them with,
--    and until now that pick was NOT DETERMINISTIC. `DISTINCT ON (politician_id)
--    ... ORDER BY politician_id, parliament DESC` leaves the row unspecified
--    when a person holds TWO terms in the SAME parliament, which is exactly what
--    a mid-parliament chamber transfer produces: Bronwyn Bishop left the Senate
--    for Mackellar in March 1994, inside the 37th. While the table was House-only
--    that case could not arise and the omission was invisible; the moment Senate
--    terms exist it becomes a view whose output can change between two refreshes
--    of identical data, and the chamber it changes is the one printed beside a
--    named person's declared holdings.
--
--    THE TIEBREAK, and why it is this one. Within a parliament the term that
--    STARTED LATER wins: a transfer's destination is the chamber the person
--    actually sat in for the rest of that parliament, and it is the chamber they
--    lodged under. When the dates cannot decide it falls to `chamber`, which
--    sorts 'house' before 'senate' — deliberately, because every holding in this
--    view came from a HOUSE register volume (there is no Senate register corpus),
--    so labelling a House lodgement 'senate' would contradict its own evidence.
--    A register-derived House term carries no dates at all, which is precisely
--    the case that fallback is for.
--
--    MEASURED BEFORE WRITING IT: across the 180 senators this migration's
--    companion job mints, ZERO hold both chambers in any parliament >= 44. The
--    tiebreak therefore changes no row today. It is a guard against the view
--    becoming non-reproducible later, not a correction of a wrong row now.
--
--    WHAT DOES CHANGE, from the DATA rather than from this SQL: a dual-chamber
--    person whose LATEST parliament is a Senate one now labels as a senator
--    rather than as the member they last were. That is correct — it is their
--    current chamber — and it is listed in the rollout report.
--
-- 2. The candidate-return resolution CHECK admits 'state_surname_given_exact',
--    the Senate arm of rule 3. A Senate candidate contests a STATE, so the
--    division join could never reach one; the new rule joins on state + surname
--    + given-name agreement instead, carrying every guard rule 3 carries.
--    Senate GROUP returns are excluded by return_type and remain unresolvable by
--    design: a ticket's return is not a person's.

BEGIN;

-- ---------------------------------------------------------------------------
-- aec_state_full_name: the state code <-> name bridge rule 3c needs.
--
-- The AEC writes the CODE in electorate_state and the FULL NAME in
-- electorate_name for a Senate candidate. Requiring BOTH to agree is what keeps
-- a division that happens to share a state's name out of the Senate rule; a
-- function makes that agreement one expression instead of an eight-branch CASE
-- copied into every query that needs it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_state_full_name(code TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE upper(btrim(coalesce(code, '')))
        WHEN 'NSW' THEN 'New South Wales'
        WHEN 'VIC' THEN 'Victoria'
        WHEN 'QLD' THEN 'Queensland'
        WHEN 'SA'  THEN 'South Australia'
        WHEN 'WA'  THEN 'Western Australia'
        WHEN 'TAS' THEN 'Tasmania'
        WHEN 'NT'  THEN 'Northern Territory'
        WHEN 'ACT' THEN 'Australian Capital Territory'
        ELSE ''
    END;
$$;

COMMENT ON FUNCTION aec_state_full_name(TEXT) IS
    'AEC state code to full name. Returns empty string for anything unrecognised, so a comparison against it withholds rather than matching.';

-- ---------------------------------------------------------------------------
-- aec_parliament_election_date: the election that returned each parliament.
--
-- Rule 3c needs it for the FRESH-MANDATE GUARD. A Senate candidate return is
-- money declared by somebody who CONTESTED that election, and a senator's term
-- runs six years — so "senator for this state in the parliament the event
-- elected" is satisfied by senators who were mid-term and did not stand at all.
-- Without a date to compare a term's start against, a namesake's return can
-- land on a sitting senator who could not have lodged it.
--
-- The dates are ELECTION DAYS and are the same map the job carries in
-- aph_parliaments.go (parliamentElectionDates), hand-verified against the
-- Handbook's own ElectorateService boundaries. Both copies exist because the
-- job needs them in Go for the term derivation and the resolver needs them in
-- SQL for a set-based rule; senate_identity.test.mjs asserts they agree.
--
-- NULL for anything unmapped, so a BETWEEN against it is NULL and the guard
-- withholds rather than matching.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_parliament_election_date(parliament INT)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE parliament
        WHEN 38 THEN DATE '1996-03-02'
        WHEN 39 THEN DATE '1998-10-03'
        WHEN 40 THEN DATE '2001-11-10'
        WHEN 41 THEN DATE '2004-10-09'
        WHEN 42 THEN DATE '2007-11-24'
        WHEN 43 THEN DATE '2010-08-21'
        WHEN 44 THEN DATE '2013-09-07'
        WHEN 45 THEN DATE '2016-07-02'
        WHEN 46 THEN DATE '2019-05-18'
        WHEN 47 THEN DATE '2022-05-21'
        WHEN 48 THEN DATE '2025-05-03'
        ELSE NULL
    END;
$$;

COMMENT ON FUNCTION aec_parliament_election_date(INT) IS
    'Election day of each parliament, 38-48. NULL for anything unmapped, so a date comparison against it withholds rather than matching.';

ALTER TABLE aec_candidate_returns
    DROP CONSTRAINT IF EXISTS aec_candidate_returns_resolution_check;
ALTER TABLE aec_candidate_returns
    ADD CONSTRAINT aec_candidate_returns_resolution_check
    CHECK (resolution_method IN (
        'unresolved', 'curated_alias', 'division_surname_given_exact',
        'state_surname_given_exact'));

-- ---------------------------------------------------------------------------
-- The public holdings view, rebuilt.
--
-- The two rollups below are recreated verbatim from 000104 because Postgres has
-- no way to replace a materialised view's body in place, and they select FROM
-- this one. Nothing about them changes.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_monthly;
DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_rollup;
DROP MATERIALIZED VIEW IF EXISTS mv_register_public_holdings;

CREATE MATERIALIZED VIEW mv_register_public_holdings AS
WITH latest_term AS (
    SELECT DISTINCT ON (politician_id)
        politician_id, parliament, chamber, division, state_code, party, party_ab
    FROM politician_terms
    ORDER BY politician_id,
             parliament DESC,
             -- The later-starting term in a parliament is the transfer's
             -- destination. NULLS FIRST keeps an UNDATED register-derived House
             -- term ahead of a dated Senate one, which is the fallback this
             -- rule wants: see the header.
             term_start DESC NULLS FIRST,
             -- Final, total order: 'house' < 'senate'.
             chamber
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
