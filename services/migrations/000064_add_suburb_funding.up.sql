-- Federal infrastructure funding mapped to a suburb (Infrastructure Investment
-- Program project coordinates → point-in-polygon). The ONLY genuinely
-- suburb-level federal funding; LGA grants live on lga.*, GST is state-level.
-- CC-BY-4.0 (DITRDCSA). See the design doc §4/§7.
CREATE TABLE IF NOT EXISTS suburb_funding (
    sal_code            TEXT PRIMARY KEY,
    infra_project_count INTEGER,
    infra_committed_aud NUMERIC,      -- sum of Commonwealth contribution
    source              TEXT NOT NULL DEFAULT 'iip',
    source_licence      TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
