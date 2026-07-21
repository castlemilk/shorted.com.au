-- Restore the original six-value constraint from 000075.
ALTER TABLE industry_intelligence_sources
    DROP CONSTRAINT IF EXISTS industry_intelligence_sources_kind_check;
ALTER TABLE industry_intelligence_sources
    ADD CONSTRAINT industry_intelligence_sources_kind_check
    CHECK (signal_kind IN (
        'short_interest',
        'trade_exposure',
        'public_money',
        'tax_environment',
        'policy_footprint',
        'emissions'
    ));
