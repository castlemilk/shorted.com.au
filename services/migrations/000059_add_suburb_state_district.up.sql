-- State electoral district per suburb (ABS State Electoral Divisions SED_2025),
-- spatially joined. The sitting state member + party is a follow-up (no single
-- machine-readable source across the 8 jurisdictions); this ships the district so
-- a suburb can show "your state seat". CC-BY-4.0 (ABS boundaries).

ALTER TABLE suburb_demographics
    ADD COLUMN IF NOT EXISTS state_district TEXT;  -- ABS State Electoral Division name
