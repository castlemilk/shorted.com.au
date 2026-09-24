-- Re-point VG/crawl suburb regions that the stripped-name SAL link attached to
-- the wrong same-named locality.
--
-- ABS parenthesises a SAL name exactly when it repeats in a state ("Mayfield
-- (Newcastle - NSW)", 9,760 people; "Mayfield (Shoalhaven - NSW)", 36). The
-- stripped pass (000068, then linkStrippedSalSQL) used to apply an arbitrary
-- one of several matches; it now takes the most populous, but it only fills
-- NULL links, so the wrong ones it made earlier stay. Measured on prod
-- 2026-09-24 (read-only): 33 suburb regions carry a stripped-pass link while a
-- more populous same-name SAL exists in the state. The VG "Mayfield" series
-- painted a 36-person Shoalhaven hamlet with Newcastle's median while Mayfield
-- (Newcastle) read as unpriced.
--
-- The target is linkStrippedSalSQL's choice verbatim (most populous, lowest
-- sal_code on a tie). Population alone is not evidence enough to OVERTURN a
-- link, though: 3 of the 33 are correct today and the populous twin is the
-- wrong place (Greenlands 2631 is Snowy Monaro, South Arm 2460 Clarence Valley,
-- Rosewood 2652 Snowy Valleys; checked against the region's own postcode).
-- So a row moves only when
--   * the other suburb regions sharing its postcode, linked by EXACT name,
--     sit in the new SAL's council more often than in the old one's, or
--   * there is no such evidence either way and the new SAL is at least twice
--     as populous (a decisive pick, not a 221-vs-218 coin flip).
-- On prod that re-points 30 rows and holds those 3.
--
-- Scope, and what is never touched:
--   * only region_type 'suburb' rows whose CURRENT link is a stripped-pass
--     link: the region name equals the SAL name only once the parenthetical
--     is removed. An exact-name link is never re-pointed, and neither is a
--     region whose exact name exists as a SAL in its state.
--   * same state only.
--   * the crawl copies of a re-pointed region's link move with it, and only
--     where they still hold the old link: property_listings.sal_code (backfilled
--     from the region by linkListingSalCodes), property_price_events.sal_code
--     (copied from the listing), and the drop index's suburb rows keyed by the
--     old SAL, re-keyed only when no region links to the old SAL any more and
--     the new key has no row for that day.
--
-- After applying: refresh_housing_materialized_views() on the session pooler,
-- then revalidate the affected suburb pages.
--
-- Hand-applied (prod does not run `migrate up`): session pooler 5432, one
-- transaction, timeout disarmed in-session because Supavisor drops PGOPTIONS.
-- Replay-safe: a replay finds nothing to move (a moved row now holds the
-- populous pick; a held row fails the same guard), and every UPDATE is keyed
-- on the old value, so it can never apply twice.

BEGIN;

SET LOCAL statement_timeout = 0;

CREATE TEMP TABLE sal_relink ON COMMIT DROP AS
    WITH linked AS (
        -- A suburb region whose CURRENT link came from the stripped pass: its name
        -- equals the linked SAL's name only once the ABS parenthetical is removed,
        -- and no same-state SAL carries its name exactly (the exact pass, which
        -- runs first, would own it).
        SELECT r.region_code, r.region_name, r.state_code, r.postcode,
               r.sal_code AS old_sal, COALESCE(d.population, 0) AS old_pop
        FROM house_price_regions r
        JOIN suburb_demographics d ON d.sal_code = r.sal_code AND d.state_code = r.state_code
        WHERE r.region_type = 'suburb'
          AND upper(trim(r.region_name)) <> upper(trim(d.sal_name))
          AND upper(trim(r.region_name)) = upper(trim(regexp_replace(d.sal_name, '\s*\(.*\)\s*$', '')))
          AND NOT EXISTS (
              SELECT 1 FROM suburb_demographics e
              WHERE e.state_code = r.state_code
                AND upper(trim(e.sal_name)) = upper(trim(r.region_name)))
    ), pick AS (
        -- linkStrippedSalSQL's choice, verbatim: the most populous same-state SAL
        -- with the stripped name, lowest sal_code on a tie.
        SELECT DISTINCT ON (k.region_code)
               k.region_code, d.sal_code AS new_sal, COALESCE(d.population, 0) AS new_pop
        FROM linked k
        JOIN suburb_demographics d
          ON d.state_code = k.state_code
         AND upper(trim(k.region_name)) = upper(trim(regexp_replace(d.sal_name, '\s*\(.*\)\s*$', '')))
        ORDER BY k.region_code, COALESCE(d.population, 0) DESC, d.sal_code
    ), mates AS (
        -- Postcode evidence: the councils of OTHER suburb regions with the same
        -- postcode whose own link is an exact-name match.
        SELECT k.region_code, sl.lga_code24, count(*) AS n
        FROM linked k
        JOIN house_price_regions o
          ON o.state_code = k.state_code AND o.postcode = k.postcode
         AND o.region_type = 'suburb' AND o.region_code <> k.region_code
        JOIN suburb_demographics od
          ON od.sal_code = o.sal_code AND upper(trim(od.sal_name)) = upper(trim(o.region_name))
        JOIN suburb_lga sl ON sl.sal_code = o.sal_code
        GROUP BY k.region_code, sl.lga_code24
    ), scored AS (
        SELECT k.region_code, k.old_sal, k.old_pop, p.new_sal, p.new_pop,
               COALESCE((SELECT m.n FROM mates m JOIN suburb_lga s ON s.lga_code24 = m.lga_code24
                         WHERE m.region_code = k.region_code AND s.sal_code = k.old_sal), 0) AS old_votes,
               COALESCE((SELECT m.n FROM mates m JOIN suburb_lga s ON s.lga_code24 = m.lga_code24
                         WHERE m.region_code = k.region_code AND s.sal_code = p.new_sal), 0) AS new_votes
        FROM linked k
        JOIN pick p USING (region_code)
        WHERE p.new_sal <> k.old_sal
          AND p.new_pop > k.old_pop
    )
    SELECT region_code, old_sal, new_sal, old_pop, new_pop, old_votes, new_votes
    FROM scored
    WHERE new_votes > old_votes
       OR (old_votes = 0 AND new_votes = 0 AND new_pop >= 2 * old_pop);

UPDATE house_price_regions r
SET sal_code = x.new_sal
FROM sal_relink x
WHERE r.region_code = x.region_code
  AND r.sal_code = x.old_sal;

UPDATE property_listings pl
SET sal_code = x.new_sal
FROM sal_relink x
WHERE pl.region_code = x.region_code
  AND pl.sal_code = x.old_sal;

UPDATE property_price_events e
SET sal_code = x.new_sal
FROM sal_relink x
JOIN property_listings pl ON pl.region_code = x.region_code
WHERE e.listing_pk = pl.id
  AND e.sal_code = x.old_sal;

UPDATE housing_drop_index_daily i
SET grain_key = x.new_sal
FROM sal_relink x
WHERE i.grain = 'suburb'
  AND i.grain_key = x.old_sal
  AND NOT EXISTS (SELECT 1 FROM house_price_regions r WHERE r.sal_code = x.old_sal)
  AND NOT EXISTS (
      SELECT 1 FROM housing_drop_index_daily t
      WHERE t.snapshot_date = i.snapshot_date AND t.grain = 'suburb' AND t.grain_key = x.new_sal);

COMMIT;
