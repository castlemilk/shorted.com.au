-- Allow the economy-collector's derived source's collection_method in the
-- shared registry. The markets source (derived-shorted-markets) is DERIVED
-- in-DB from the ASIC shorts history × the company→state exposure model, not
-- fetched from any web endpoint, so its collection_method is 'derived' rather
-- than api/ckan/download/html/manual.
ALTER TABLE industry_intelligence_sources
    DROP CONSTRAINT IF EXISTS industry_intelligence_sources_method_check;
ALTER TABLE industry_intelligence_sources
    ADD CONSTRAINT industry_intelligence_sources_method_check
    CHECK (collection_method IN (
        'api', 'ckan', 'download', 'html', 'manual', 'derived'
    ));
