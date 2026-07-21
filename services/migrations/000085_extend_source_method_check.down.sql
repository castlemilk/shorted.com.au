-- Restore the original five-value collection_method constraint from 000075.
ALTER TABLE industry_intelligence_sources
    DROP CONSTRAINT IF EXISTS industry_intelligence_sources_method_check;
ALTER TABLE industry_intelligence_sources
    ADD CONSTRAINT industry_intelligence_sources_method_check
    CHECK (collection_method IN (
        'api', 'ckan', 'download', 'html', 'manual'
    ));
