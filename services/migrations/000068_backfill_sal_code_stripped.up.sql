-- Re-link priced suburbs whose exact name did NOT match an ABS SAL because the
-- SAL name carries a disambiguating parenthetical qualifier — e.g. NSW VG
-- "ABBOTSFORD" vs ABS "Abbotsford (NSW)". The original backfill (000056) matches
-- exactly and leaves these NULL; this adds a fallback that strips a trailing
-- "(...)" from the ABS name before comparing. Only touches still-NULL suburb
-- regions, so it never overrides an exact match. Imperfect by design (a stripped
-- name that collides within a state resolves arbitrarily) — unmatched rows keep a
-- NULL sal_code and simply won't paint. Verified to lift NSW name→SAL coverage
-- from 84% to ~100% of ingested suburbs.
UPDATE house_price_regions r
SET sal_code = d.sal_code
FROM suburb_demographics d
WHERE r.sal_code IS NULL
  AND r.region_type = 'suburb'
  AND r.state_code = d.state_code
  AND upper(trim(r.region_name)) = upper(trim(regexp_replace(d.sal_name, '\s*\(.*\)\s*$', '')));
