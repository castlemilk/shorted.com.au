#!/bin/bash
set -e

echo "🔄 Importing existing resources into Terraform state..."
echo ""

echo "1️⃣  Importing Artifact Registry..."
terraform import google_artifact_registry_repository.shorted \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/repositories/shorted

echo ""
echo "2️⃣  Importing Stock Price Ingestion service..."
terraform import module.stock_price_ingestion.google_cloud_run_v2_service.stock_price_ingestion \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/stock-price-ingestion

echo ""
echo "3️⃣  Importing Shorts API service..."
terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts

echo ""
echo "4️⃣  Importing Short Data Sync job..."
terraform import module.short_data_sync.google_cloud_run_v2_job.short_data_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/jobs/shorts-data-sync

echo ""
echo "5️⃣  Importing GCS bucket..."
terraform import module.short_data_sync.google_storage_bucket.short_selling_data \
  shorted-short-selling-data

echo ""
echo "6️⃣  Importing Stock Price Daily Sync scheduler..."
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.daily_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-daily-sync

echo ""
echo "7️⃣  Importing Stock Price Weekly Backfill scheduler..."
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.weekly_backfill \
  projects/shorted-dev-aba5688f/locations/australia-southeast1/jobs/stock-price-weekly-sync

echo ""
echo "✅ Import complete!"
echo ""
echo "Next step: Run 'terraform plan' to verify"
