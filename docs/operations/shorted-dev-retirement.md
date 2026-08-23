# Shorted dev retirement

Target project: `shorted-dev-aba5688f`

Production still depends on two dev-hosted buckets:

- `shorted-company-logos` -> `shorted-company-logos-prod`
- `shorted-financial-reports` -> `shorted-financial-reports-prod`

First apply only the reviewed production bucket/IAM additions. Then run
`node scripts/shorted-dev-storage-migration.mjs` for a checksum dry-run.
Copying requires
`CONFIRM_SHORTED_DEV_STORAGE_MIGRATION=prod node scripts/shorted-dev-storage-migration.mjs --apply`.

After a second dry-run proposes no copies, use a separate PR to change runtime
and stored database URLs. Run production API/page smoke and retain the source
buckets for a 24-hour rollback window. Only then remove dev/preview automation,
review the exact project-deletion proposal, and delete the dev project.
