-- Records the MATCH GRANULARITY of a property.com.au valuation so a whole-building
-- AVM is never silently consumed as a unit-precise one.
--
-- The resolver (crawl_property_resolve.go) resolves a display address to a
-- property.com.au profile via the address-search API. A unit address ("33/175
-- Kelletts Road") normally resolves to its EXACT unit profile ('exact'); but when
-- that specific unit isn't indexed, it falls back to the base BUILDING's profile
-- ('building') — a whole-building AVM stored against the unit's address_key. Without
-- this column those two rows are indistinguishable, so any future read path could
-- attribute a building-level estimate to a specific unit.
--
--   'exact'    — the profile is the exact dwelling the address names (a house
--                resolved to its own profile, or a unit resolved to its unit profile)
--   'building' — a unit address that fell back to its base-building profile
--   NULL       — no valuation (notfound / error / blocked rows)
--
-- Gate any per-DWELLING consumption on valuation_granularity = 'exact'.

ALTER TABLE property_valuations
    ADD COLUMN IF NOT EXISTS valuation_granularity TEXT;
