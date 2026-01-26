# Stock Price Ingestion Outputs
output "stock_price_ingestion_url" {
  description = "URL of the stock price ingestion service"
  value       = module.stock_price_ingestion.service_url
}

output "stock_price_ingestion_service_account" {
  description = "Service account email for stock price ingestion"
  value       = module.stock_price_ingestion.service_account_email
}

output "stock_price_daily_sync_job" {
  description = "Stock price daily sync Cloud Scheduler job name"
  value       = module.stock_price_ingestion.daily_sync_job_name
}

output "stock_price_weekly_backfill_job" {
  description = "Stock price weekly backfill Cloud Scheduler job name"
  value       = module.stock_price_ingestion.weekly_backfill_job_name
}

# Short Data Sync Outputs
output "short_data_sync_job_name" {
  description = "Name of the short data sync Cloud Run job"
  value       = module.short_data_sync.job_name
}

output "short_data_sync_bucket" {
  description = "GCS bucket for short selling data"
  value       = module.short_data_sync.bucket_name
}

output "short_data_sync_scheduler_job" {
  description = "Short data sync Cloud Scheduler job name"
  value       = module.short_data_sync.scheduler_job_name
}

# Shorts API Outputs
output "shorts_api_url" {
  description = "URL of the Shorts API service"
  value       = module.shorts_api.service_url
}

output "shorts_api_service_account" {
  description = "Service account email for Shorts API"
  value       = module.shorts_api.service_account_email
}

# Infrastructure Outputs
output "artifact_registry_repository" {
  description = "Artifact Registry repository for Docker images"
  value       = "australia-southeast2-docker.pkg.dev/${var.project_id}/shorted"
}

