-- An index for the federal-division lookups the politician pages run per
-- member (DBP-05, 2026-10-21 database review).
--
-- Four reads match a member's division to suburbs by the normalised name,
-- upper(btrim(federal_division)) = upper(btrim(<division>)): the party
-- fallback LATERAL in the hub list and the member profile
-- (postgres_politician_explorer.go politicianSummarySelectWith), the same
-- LATERAL in the politicians list (postgres_politicians.go), and the
-- represented-suburbs list on a member page. No index serves that
-- expression, so each is a sequential scan of suburb_demographics; the list
-- forms run one per member with a division (318 of 491). Measured on prod
-- since 2026-07-23: suburb_demographics took 4.05M sequential scans; the
-- member profile read (29,080 calls, 680 ms mean) plans
--   Seq Scan on suburb_demographics
--     Filter: (federal_party IS NOT NULL) AND (upper(btrim(federal_division)) = upper(btrim(politician_terms.division)))
-- Every division carries exactly one party (150 divisions, 0 with two), so the
-- LATERAL's LIMIT 1 pick is the same whichever suburb row it lands on.
--
-- Not partial (WHERE federal_party IS NOT NULL), so the represented-suburbs
-- read, which has no party predicate, uses it too; the party columns ride in
-- INCLUDE so the LATERALs can answer from the index.
--
-- A plain CREATE INDEX, not CONCURRENTLY: the table is 15,345 rows (23 MB) and
-- the build takes well under a second. It holds a SHARE lock for that time,
-- which blocks only writers (the collector's monthly ingests), never readers,
-- and lock_timeout bounds the wait for one. That keeps the file one
-- transaction for `task db:prod:apply` and runnable by `migrate up`.
--
-- Hand-applied (prod does not run `migrate up`):
--   task db:prod:apply FILE=services/migrations/000140_suburb_demographics_division_index.up.sql CONFIRM=prod
-- Replay-safe: IF NOT EXISTS, and ANALYZE only refreshes statistics (it gives
-- the planner the expression's statistics the first time).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_suburb_demographics_federal_division
    ON suburb_demographics ((upper(btrim(federal_division))))
    INCLUDE (federal_party, federal_party_ab);

ANALYZE suburb_demographics;

COMMIT;
