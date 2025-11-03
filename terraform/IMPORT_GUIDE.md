# Importing Existing Resources into Terraform

This guide helps import existing GCP resources into Terraform state.

## Resources to Import

Based on existing infrastructure:

### 1. Artifact Registry
```bash
cd terraform/environments/dev

terraform import google_artifact_registry_repository.shorted \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/repositories/shorted
```

### 2. Cloud Run Services

#### Stock Price Ingestion Service
```bash
terraform import module.stock_price_ingestion.google_cloud_run_v2_service.stock_price_ingestion \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/stock-price-ingestion
```

#### Shorts API Service
```bash
terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts
```

### 3. Cloud Run Jobs

#### Short Data Sync Job (note: existing name is "shorts-data-sync" not "short-data-sync")
```bash
terraform import module.short_data_sync.google_cloud_run_v2_job.short_data_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/jobs/shorts-data-sync
```

### 4. GCS Bucket
```bash
terraform import module.short_data_sync.google_storage_bucket.short_selling_data \
  shorted-short-selling-data
```

### 5. Cloud Scheduler Jobs (australia-southeast1)

#### Stock Price Daily Sync
```bash
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.daily_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-daily-sync
```

#### Stock Price Weekly Backfill
```bash
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.weekly_backfill \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-weekly-sync
```

#### Short Data Daily Sync
```bash
terraform import module.short_data_sync.google_cloud_scheduler_job.daily_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/short-data-daily-sync
```

## Import All at Once

Run this script to import all existing resources:

```bash
#!/bin/bash
cd terraform/environments/dev

echo "Importing Artifact Registry..."
terraform import google_artifact_registry_repository.shorted \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/repositories/shorted

echo "Importing Stock Price Ingestion service..."
terraform import module.stock_price_ingestion.google_cloud_run_v2_service.stock_price_ingestion \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/stock-price-ingestion

echo "Importing Shorts API service..."
terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts

echo "Importing Short Data Sync job..."
terraform import module.short_data_sync.google_cloud_run_v2_job.short_data_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/jobs/shorts-data-sync

echo "Importing GCS bucket..."
terraform import module.short_data_sync.google_storage_bucket.short_selling_data \
  shorted-short-selling-data

echo "Importing scheduler jobs..."
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.daily_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-daily-sync

terraform import module.stock_price_ingestion.google_cloud_scheduler_job.weekly_backfill \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-weekly-sync

echo "✅ Import complete!"
echo "Run 'terraform plan' to verify"
```

## After Import

1. Run `terraform plan` to verify no changes are needed
2. If there are differences, update Terraform configuration to match existing resources
3. Once plan shows no changes, Terraform is managing the resources

## Notes

- Service accounts may need to be imported separately if they already exist
- IAM bindings will be created fresh (existing ones won't conflict)
- Some resources like API enablements can't be imported and will just be enabled

## Troubleshooting

### Resource ID Format Wrong
Check the exact resource ID format:
```bash
gcloud run services list --project=shorted-dev-aba5688f --region=australia-southeast2 --uri
gcloud scheduler jobs list --project=shorted-dev-aba5688f --location=australia-southeast1 --uri
```

### Import Fails
If import fails, the resource might not exist or the ID format is wrong. Double-check with:
```bash
gcloud [resource-type] describe [resource-name] --project=shorted-dev-aba5688f
```

