-- Suburb pages stop recomputing data that only changes when an official
-- source loads (DBP-01, docs: the 2026-10-21 database review).
--
-- Measured on prod, pg_stat_statements since 2026-07-23 (90 days): the suburb
-- profile, its similar-suburbs kNN and the state suburb list were 33% of all
-- database time (about 220k s). Every cache miss recomputed, for ONE suburb:
--   * the state price baseline: the latest public median of every suburb in
--     the state (an index scan over all 26.8k suburb medians for NSW);
--   * 13 Census references over every suburb in the state, and the national
--     income median over all 15,345 suburbs;
--   * six standard deviations over all suburbs joined to amenities, then the
--     distance to every candidate (similarSuburbs);
--   * the latest price and the price 11 months earlier, per suburb row, via a
--     LATERAL with two index probes (preferredSuburbRegionJoin; about 10k
--     probes for a full state list).
-- suburb_demographics (15k rows) took 4.04M seq scans and 44.4bn tuple reads;
-- idx_house_prices_series (40k rows) took 818M scans.
--
-- These three views hold that work, computed once per refresh:
--
-- 1. mv_suburb_latest_price: one row per SAL, the same public-licence region
--    and price the live LATERAL picks (same licence gate, same preference
--    order: priced first, newest period, then region_code). Read by
--    ListStateSuburbs, GetSuburbProfile, similarSuburbs, the suburb metric
--    columns and the council suburb table, joined by sal_code.
-- 2. mv_housing_state_baselines: one row per state, the profile's state
--    price median, its 13 Census references and the national income median.
-- 3. mv_suburb_similarity_features: the six similarity features per SAL,
--    each divided by its standard deviation over suburbs of more than 200
--    people. (x - t)/s = x/s - t/s, so the distance is unchanged and a NULL or
--    zero deviation drops the term exactly as before. Stored as float8.
--
-- Parity, measured read-only on prod 2026-10-21 by running these bodies next
-- to the live SQL: latest price 15,345 SALs, 0 mismatches (3,795 rows); state
-- baselines identical for all 8 states; similar suburbs identical sets and
-- order for 25 sampled targets, distance difference below 1e-12. The live
-- "latest" pick has no tie-break, and prod has 0 suburb regions with two
-- public medians for one period.
--
-- Refresh: refresh_suburb_reference_views(), called by house-price-collector
-- after the official ingest, the residential Valuer-General runs, -mode
-- refresh, the census and amenity loads, and the crime load. Not after agent
-- or listing crawl drains: the crawl writes only proprietary rows, which none
-- of these views read. It records nothing in housing_mv_refresh on purpose:
-- the freshness sentinel (housing-freshness.yml) alarms on any row there older
-- than 72 hours, and these views change monthly. By hand:
--   task db:prod:refresh WHICH=suburbs CONFIRM=prod
--
-- The API reads the views and falls back to the live SQL only when a view does
-- not exist (42P01), so code may deploy before this file is applied.
--
-- Hand-applied (prod does not run `migrate up`): `task db:prod:apply
-- FILE=services/migrations/000139_suburb_reference_mvs.up.sql CONFIRM=prod`,
-- session pooler 5432, one transaction. The views are only built when absent,
-- so a replay builds nothing; it re-issues the refresh function (this file
-- owns it, nothing else defines it) and re-analyzes three small views. Every
-- view builds in about a second: the read-only parity probes that ran these
-- bodies beside the live SQL on prod took 1.2 s and 2.5 s in all. They are new
-- objects, so the build blocks no reader.

BEGIN;

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1. Latest public median price + YoY per SAL (preferredSuburbRegionJoin).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_suburb_latest_price AS
SELECT DISTINCT ON (sr.sal_code)
       sr.sal_code, sr.region_code, hp.value, hp.period, hp.yoy_pct
FROM house_price_regions sr
LEFT JOIN LATERAL (
    SELECT latest.value, latest.period,
           (latest.value / NULLIF((
              SELECT prior.value FROM house_prices prior
              WHERE prior.region_code = sr.region_code AND prior.measure = 'median_price'
                AND prior.dwelling_type = 'house' AND prior.source_licence <> 'proprietary-tos-restricted'
                AND prior.period <= latest.period - INTERVAL '11 months'
              ORDER BY prior.period DESC LIMIT 1), 0) - 1) * 100 AS yoy_pct
    FROM house_prices latest
    WHERE latest.region_code = sr.region_code AND latest.measure = 'median_price'
      AND latest.dwelling_type = 'house' AND latest.source_licence <> 'proprietary-tos-restricted'
    ORDER BY latest.period DESC LIMIT 1
) hp ON true
WHERE sr.region_type = 'suburb' AND sr.sal_code IS NOT NULL
ORDER BY sr.sal_code,
         (hp.value IS NOT NULL) DESC,
         hp.period DESC NULLS LAST,
         sr.region_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_latest_price_sal
    ON mv_suburb_latest_price (sal_code);

COMMENT ON MATERIALIZED VIEW mv_suburb_latest_price IS
    'One public-licence suburb price identity per SAL: the region, latest median and YoY the live preferredSuburbRegionJoin picks (priced first, newest period, region_code). Proprietary rows never enter. Refreshed by refresh_suburb_reference_views().';

-- ---------------------------------------------------------------------------
-- 2. State baselines for the profile (price, Census references, income) and
--    the national income median. Mirrors GetSuburbProfile's live baselines.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_housing_state_baselines AS
WITH latest AS (
    SELECT DISTINCT ON (hp.region_code) sr.state_code, hp.value
    FROM house_prices hp
    JOIN house_price_regions sr ON sr.region_code = hp.region_code
    WHERE sr.region_type = 'suburb' AND hp.source_licence <> 'proprietary-tos-restricted'
      AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
    ORDER BY hp.region_code, hp.period DESC
), price AS (
    SELECT state_code, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS state_median_price
    FROM latest
    GROUP BY state_code
), census AS (
    SELECT sd.state_code,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY sd.median_weekly_hhd_income)
             FILTER (WHERE sd.median_weekly_hhd_income > 0) AS median_hhd_income,
           SUM(sd.pct_owned_outright * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_owned_outright IS NOT NULL), 0) AS pct_owned_outright,
           SUM(sd.pct_owned_mortgage * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_owned_mortgage IS NOT NULL), 0) AS pct_owned_mortgage,
           SUM(sd.pct_rented * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_rented IS NOT NULL), 0) AS pct_rented,
           SUM(sd.pct_separate_house * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_separate_house IS NOT NULL), 0) AS pct_separate_house,
           SUM(sd.pct_flat_apartment * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_flat_apartment IS NOT NULL), 0) AS pct_flat_apartment,
           SUM(sd.pct_couple_with_children * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_couple_with_children IS NOT NULL), 0) AS pct_couple_with_children,
           SUM(sd.pct_lone_person_household * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_lone_person_household IS NOT NULL), 0) AS pct_lone_person_household,
           SUM(sd.unemployment_rate * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.unemployment_rate IS NOT NULL), 0) AS unemployment_rate,
           SUM(sd.labour_force_participation_rate * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.labour_force_participation_rate IS NOT NULL), 0) AS labour_force_participation_rate,
           SUM(sd.pct_bachelor_or_higher * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_bachelor_or_higher IS NOT NULL), 0) AS pct_bachelor_or_higher,
           SUM(sd.pct_low_personal_income * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_low_personal_income IS NOT NULL), 0) AS pct_low_personal_income,
           SUM(sd.pct_high_personal_income * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_high_personal_income IS NOT NULL), 0) AS pct_high_personal_income
    FROM suburb_demographics sd
    GROUP BY sd.state_code
), nat AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_weekly_hhd_income) AS national_median_hhd_income
    FROM suburb_demographics
    WHERE median_weekly_hhd_income > 0
)
SELECT c.state_code,
       p.state_median_price,
       c.median_hhd_income,
       nat.national_median_hhd_income,
       c.pct_owned_outright, c.pct_owned_mortgage, c.pct_rented,
       c.pct_separate_house, c.pct_flat_apartment,
       c.pct_couple_with_children, c.pct_lone_person_household,
       c.unemployment_rate, c.labour_force_participation_rate,
       c.pct_bachelor_or_higher,
       c.pct_low_personal_income, c.pct_high_personal_income,
       now() AS computed_at
FROM census c
LEFT JOIN price p ON p.state_code = c.state_code
CROSS JOIN nat;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_state_baselines_state
    ON mv_housing_state_baselines (state_code);

COMMENT ON MATERIALIZED VIEW mv_housing_state_baselines IS
    'Per-state suburb-profile baselines: median of the latest public suburb median, the median suburb household income, dwelling- or resident-weighted Census shares, and the national median suburb income. computed_at = when it was last refreshed. Refreshed by refresh_suburb_reference_views().';

-- ---------------------------------------------------------------------------
-- 3. Similar-suburbs features, divided by their deviation (similarSuburbs).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_suburb_similarity_features AS
WITH f AS (
    SELECT d.sal_code, d.population, d.median_age, d.median_weekly_hhd_income, d.pct_born_overseas,
           COALESCE(a.amenity_density_score, 0) AS den,
           ln(GREATEST(d.population, 1)) AS lpop,
           LEAST(COALESCE(a.dist_to_coast_km, 0), 100) AS coast
    FROM suburb_demographics d
    LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
), s AS (
    SELECT NULLIF(stddev_pop(median_age), 0) AS sage,
           NULLIF(stddev_pop(median_weekly_hhd_income), 0) AS sinc,
           NULLIF(stddev_pop(pct_born_overseas), 0) AS sbo,
           NULLIF(stddev_pop(den), 0) AS sden,
           NULLIF(stddev_pop(lpop), 0) AS spop,
           NULLIF(stddev_pop(coast), 0) AS scoast
    FROM f
    WHERE population > 200
)
SELECT f.sal_code,
       (f.population > 200 AND f.median_age IS NOT NULL AND f.median_weekly_hhd_income IS NOT NULL) AS candidate,
       (f.median_age / s.sage)::float8 AS z_age,
       (f.median_weekly_hhd_income / s.sinc)::float8 AS z_inc,
       (f.pct_born_overseas / s.sbo)::float8 AS z_bo,
       (f.den / s.sden)::float8 AS z_den,
       (f.lpop / s.spop)::float8 AS z_pop,
       (f.coast / s.scoast)::float8 AS z_coast
FROM f
CROSS JOIN s;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_similarity_features_sal
    ON mv_suburb_similarity_features (sal_code);

COMMENT ON MATERIALIZED VIEW mv_suburb_similarity_features IS
    'Per-SAL similarity features (age, household income, born overseas, amenity density, log population, coast distance capped at 100km), each divided by its stddev_pop over suburbs of more than 200 people. candidate = may appear as a similar suburb. Refreshed by refresh_suburb_reference_views().';

-- ---------------------------------------------------------------------------
-- 4. Refresh function: each view independently, concurrent first, a blocking
--    refresh as fallback, then a 'Skipping' WARNING (which
--    `scripts/prod-psql.sh refresh` turns into a non-zero exit).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_suburb_reference_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_latest_price;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_latest_price concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_latest_price;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_latest_price: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_state_baselines;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_housing_state_baselines concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_housing_state_baselines;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_housing_state_baselines: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_similarity_features;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_similarity_features concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_similarity_features;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_similarity_features: %', SQLERRM;
    END;
END;
$$;

-- CREATE OR REPLACE resets the function's SET clauses: re-arm the timeout the
-- other refresh functions carry (000107, 000124, 000127).
ALTER FUNCTION refresh_suburb_reference_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_suburb_reference_views() IS
    'Refreshes the suburb reference views (mv_suburb_latest_price, mv_housing_state_baselines, mv_suburb_similarity_features) independently: concurrent, blocking fallback, then a Skipping WARNING. Called by house-price-collector after official and Census/amenity loads, never after a crawl drain.';

-- Fresh statistics for the three new views, so the readers' joins plan on real
-- row counts from the first request.
ANALYZE mv_suburb_latest_price;
ANALYZE mv_housing_state_baselines;
ANALYZE mv_suburb_similarity_features;

COMMIT;
