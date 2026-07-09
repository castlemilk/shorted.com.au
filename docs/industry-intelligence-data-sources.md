# Industry Intelligence Data Sources

This document records the public-source collection posture for the `/industry-intelligence`
surface. The product must show implemented, cited facts only. Planned or blocked feeds stay
out of the user-facing UI until imported, reconciled, reviewed, and dated.

## Publication Rules

- Prefer official APIs, CKAN package metadata, CSV, XLSX, or other published downloads before
  any HTML crawling.
- Do not bypass CAPTCHA, login walls, CloudFront/WAF denials, robots restrictions, or rate
  limits.
- Publish company-level facts only after exact ABN or manually reviewed entity resolution.
- Do not publish fuzzy matches. Keep fuzzy/entity candidates internal until reviewed.
- Flip `industry_intelligence_sources.public_enabled` only after records from that source have
  been imported.
- Use neutral labels. Avoid terms that imply wrongdoing or influence unless the source record
  explicitly supports that wording.

## Active Feeds

| Source | Collector key | Access path | Public status |
| --- | --- | --- | --- |
| ASIC short position reports | `asic-short-interest` | Existing daily short-interest pipeline | Public, live |
| ATO Corporate Tax Transparency | `ato-corporate-tax-transparency` | data.gov.au CKAN package | Public after exact ASX mapping |
| Clean Energy Regulator NGER corporate emissions | `cer-nger-corporate-emissions` | CER page download link discovery, CSV parse | Public after exact ABN mapping |
| AusTender contract notices | `austender-contract-notices` | data.gov.au CKAN historical resources, CSV/XLSX parse | Public after exact supplier ABN mapping |

## Source-Ready Feeds

| Source | Collector key | Current state |
| --- | --- | --- |
| ABS International Trade in Goods | `abs-international-trade-goods` | Official XLSX downloads are discoverable. Needs reviewed commodity/industry crosswalk before publication. |
| ABS Input-Output Tables | `abs-input-output-tables` | Official XLSX downloads are discoverable. Needs industry mapping and metric design before publication. |
| GrantConnect grants awarded | `grantconnect-awards` | Official reports URL is identified, but current unauthenticated automated access returned HTTP 403 from CloudFront. Do not bypass. |
| AEC Transparency Register | `aec-transparency-register` | Official download page is identified. Bulk annual endpoint returned HTTP 500 during probe. Retry later using normal access only. |
| Register of Lobbyists | `agd-register-lobbyists` | Official register page is identified. Needs exact client/entity extraction and review. |
| Foreign Influence Transparency Scheme | `agd-fits-register` | Official register page is identified. Needs exact client/entity extraction and review. |

## Collector Modes

Run from `services/` with `DATABASE_URL` set:

```bash
go run ./influence-collector -mode sources
go run ./influence-collector -mode tax-records
go run ./influence-collector -mode emissions
go run ./influence-collector -mode austender -source-limit 2
go run ./influence-collector -mode public-records
```

`public-records` refreshes the source registry, projects already-ingested ATO tax rows into
`industry_intelligence_records`, and imports exact-matched CER and AusTender records.

Production deployment uses `-mode all` only when `corporate_tax` is empty. Existing production
databases run `-mode public-records` so the newer public evidence layers are populated even when
the ATO bootstrap has already completed.
