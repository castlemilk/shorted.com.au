# Shorted dev retirement

Target project: `shorted-dev-aba5688f`

Production previously depended on two dev-hosted buckets:

- `shorted-company-logos` -> `shorted-company-logos-prod`
- `shorted-financial-reports` -> `shorted-financial-reports-prod`

## Completed prerequisites

- Production bucket and least-privilege producer IAM resources applied.
- Checksum copy completed and a second dry-run proposed no changes.
- Source and destination inventories both contain 15,465 logo objects and
  127,152 financial-report objects.
- The cutover proposal removes CI preview deployment/cleanup, Cost Guardian's
  dev matrix entries, and the Terraform dev/preview configurations so merged
  automation cannot recreate or authenticate to the project.

## IAM audit

The production project policy, all 20 production secret policies, all eight
production bucket policies, and all eight production Cloud Run service
policies were checked for principals from `shorted-dev-aba5688f`. None were
present, so no production binding needed revocation. Runtime, Cloud Run job,
Scheduler, and Pub/Sub configurations likewise contained no dev identity.

The remaining dev-only GitHub Actions identity and Workload Identity resources
belong to the target project. They stop being usable once the reviewed workflow
removal lands, and are removed with the project rather than replaced by broader
production IAM.

## Production data-rewrite proposal

The one-shot SQL proposal `docs/operations/sql/retire-dev-bucket-urls.up.sql`
is deliberately outside the automatic migration directory. Applying it requires
a separate explicit approval because it updates live production rows and
refreshes five materialized views.

Live read-only inventory captured before the proposal:

- company logo URL columns: 2,140 rows
- `key_people` JSON: 1,036 rows
- `financial_reports` JSON: 1,353 rows
- `financial_report_files`: 1,237 rows
- `financial_report_extractions`: 622 rows

The SQL matches complete old URI prefixes, so it cannot turn an existing
`-prod` URL into `-prod-prod`. Every update has been validated with `EXPLAIN`
against the production schema. The down migration intentionally preserves the
production-owned URLs; returning data to a retired project is not a safe
rollback.

After approval:

1. Apply `docs/operations/sql/retire-dev-bucket-urls.up.sql` through a
   reviewed one-shot production database operation.
2. Re-run the inventory query and require zero old URI/bucket references.
3. Run `make algolia-sync-prod` with the production database credential so
   search records receive the production logo URLs.
4. Smoke production API, logo, report-download, search, and key-person image
   surfaces; check Cloud Run and Vercel logs for old bucket names and 4xx/5xx.
5. Retain the dev project for a 24-hour observation window, then submit the
   exact `gcloud projects delete shorted-dev-aba5688f` action.

Deleting the project removes its 548 Secret Manager versions, including six
older enabled versions. Production secret-version cleanup remains a separate
proposal: protect `latest` and all aliases/references, disable older versions
first, and do not destroy versions without explicit irreversible-action
approval.

A production dry-run protected 18 explicit live runtime references and proposed
disabling 28 older enabled `INTERNAL_SERVICE_SECRET` versions. It changed zero
versions. Disabling is reversible hygiene but does not reduce Secret Manager
storage cost; only a separately approved destruction pass would do that.
