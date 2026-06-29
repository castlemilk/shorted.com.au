-- Link priced suburbs (house_price_regions, region_type='suburb') to their ABS
-- SAL via normalised name + state. Imperfect by design — unmatched rows keep a
-- NULL sal_code and simply won't paint/merge with demographics.
UPDATE house_price_regions r
SET sal_code = d.sal_code
FROM suburb_demographics d
WHERE r.sal_code IS NULL
  AND r.region_type = 'suburb'
  AND r.state_code = d.state_code
  AND upper(trim(r.region_name)) = upper(trim(d.sal_name));
