-- NBN access-technology profile per suburb (CC-BY-4.0, NBN Co via DITRDCA).
-- Area-level only — never an address-level availability promise (NBN disclaimer).
CREATE TABLE IF NOT EXISTS suburb_connectivity (
    sal_code                   TEXT PRIMARY KEY,
    dominant_nbn_tech          TEXT,    -- FTTP|HFC|FTTC|FTTB|FTTN|FW|Satellite
    pct_fixed_line             NUMERIC,
    pct_fixed_wireless         NUMERIC,
    pct_satellite              NUMERIC,
    connectivity_quality_score NUMERIC, -- 0..100, tech tier weighted by address share
    pct_fttp_upgrade_eligible  NUMERIC,
    source                     TEXT NOT NULL DEFAULT 'nbn_footprint',
    source_licence             TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
