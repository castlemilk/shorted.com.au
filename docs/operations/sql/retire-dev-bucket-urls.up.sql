-- Move persisted asset references from the two buckets owned by the retiring
-- development project to their production-owned, checksum-verified copies.
-- Match complete URI prefixes so reruns can never turn "-prod" into
-- "-prod-prod".

UPDATE "company-metadata"
SET
    logo_gcs_url = replace(
        logo_gcs_url,
        'https://storage.googleapis.com/shorted-company-logos/',
        'https://storage.googleapis.com/shorted-company-logos-prod/'
    ),
    logo_icon_gcs_url = replace(
        logo_icon_gcs_url,
        'https://storage.googleapis.com/shorted-company-logos/',
        'https://storage.googleapis.com/shorted-company-logos-prod/'
    ),
    logo_svg_gcs_url = replace(
        logo_svg_gcs_url,
        'https://storage.googleapis.com/shorted-company-logos/',
        'https://storage.googleapis.com/shorted-company-logos-prod/'
    )
WHERE logo_gcs_url LIKE '%https://storage.googleapis.com/shorted-company-logos/%'
   OR logo_icon_gcs_url LIKE '%https://storage.googleapis.com/shorted-company-logos/%'
   OR logo_svg_gcs_url LIKE '%https://storage.googleapis.com/shorted-company-logos/%';

UPDATE "company-metadata"
SET key_people = replace(
    key_people::text,
    'https://storage.googleapis.com/shorted-company-logos/',
    'https://storage.googleapis.com/shorted-company-logos-prod/'
)::jsonb
WHERE key_people::text LIKE '%https://storage.googleapis.com/shorted-company-logos/%';

UPDATE "company-metadata"
SET financial_reports = replace(
    financial_reports::text,
    'https://storage.googleapis.com/shorted-financial-reports/',
    'https://storage.googleapis.com/shorted-financial-reports-prod/'
)::jsonb
WHERE financial_reports::text LIKE '%https://storage.googleapis.com/shorted-financial-reports/%';

UPDATE financial_report_files
SET
    gcs_url = replace(
        gcs_url,
        'https://storage.googleapis.com/shorted-financial-reports/',
        'https://storage.googleapis.com/shorted-financial-reports-prod/'
    ),
    gcs_bucket = CASE
        WHEN gcs_bucket = 'shorted-financial-reports'
        THEN 'shorted-financial-reports-prod'
        ELSE gcs_bucket
    END
WHERE gcs_url LIKE '%https://storage.googleapis.com/shorted-financial-reports/%'
   OR gcs_bucket = 'shorted-financial-reports';

UPDATE financial_report_extractions
SET raw_text_gcs_url = replace(
    raw_text_gcs_url,
    'gs://shorted-financial-reports/',
    'gs://shorted-financial-reports-prod/'
)
WHERE raw_text_gcs_url LIKE '%gs://shorted-financial-reports/%';

-- These materialized views store logo URLs rather than resolving them at read
-- time. Refresh them before the old project is retired so no API response can
-- retain a stale dev-bucket URL.
REFRESH MATERIALIZED VIEW mv_screener_data;
REFRESH MATERIALIZED VIEW mv_top_shorts;
REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
REFRESH MATERIALIZED VIEW mv_short_campaigns;
REFRESH MATERIALIZED VIEW mv_company_state_exposure;
