-- Migration 000121: mark an economic series as internal-only (#601 follow-up)
--
-- Every surface over economic_series is PUBLIC and unauthenticated:
-- ListEconomicSeries, GetEconomicSeries and ListSeriesCorrelations all carry
-- VISIBILITY_PUBLIC, the MCP server exposes the same three, and
-- /industry-intelligence has no auth in its route. So "ingested" has, until
-- now, meant "published" — there was no third state.
--
-- That is fine for ABS/RBA/DCCEEW, which are CC-BY-4.0 and meant to be
-- redistributed. It is not fine for every source we might want to REASON over.
-- FRED's own metadata for VIXCLS reads:
--
--   "Copyright, 2016, Chicago Board Options Exchange, Inc. Reprinted with
--    permission."
--
-- Permission granted to FRED, not onward. The three Federal Reserve series
-- alongside it (H.15 DGS2/DGS10, H.10 DTWEXBGS) carry no such notice and stay
-- public.
--
-- Default FALSE, so every existing series keeps exactly the visibility it has
-- today and this migration cannot silently hide anything.
--
-- The flag gates the READ surface, not ingestion: internal series are still
-- collected, still correlated, still queryable by anything with direct database
-- access (the omega research host, internal tooling, a psql session). What they
-- are not is served to an anonymous caller.
--
-- REPLAY-SAFE: ADD COLUMN IF NOT EXISTS, and the index likewise.

ALTER TABLE economic_series
  ADD COLUMN IF NOT EXISTS internal_only BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN economic_series.internal_only IS
  'TRUE = withheld from the public API surface (List/GetEconomicSeries, ListSeriesCorrelations) and from the site. Still ingested and still correlated; readable only with direct database access. Used for sources whose licence permits internal analysis but not redistribution.';

-- The public queries all filter on this, so it belongs in the index that serves
-- the catalog listing rather than forcing a seq scan on every anonymous call.
CREATE INDEX IF NOT EXISTS idx_economic_series_public
  ON economic_series (topic, metric, region_type, region_code)
  WHERE internal_only = false;
