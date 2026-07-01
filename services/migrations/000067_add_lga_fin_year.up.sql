-- Reporting-year vintage for the lga financial columns (avg_rates,
-- op_surplus_ratio, asset_renewal_ratio) — those columns already exist (000061);
-- this records which LGPRF year they came from (e.g. '2024-25'), mirroring
-- fed_fag_year. VIC LGPRF is CC-BY-4.0 (Local Government Victoria).
ALTER TABLE lga
    ADD COLUMN IF NOT EXISTS fin_year TEXT;
