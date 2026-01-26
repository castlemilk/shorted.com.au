output "service_url" {
  description = "URL of the deployed Cloud Run service"
  value       = google_cloud_run_v2_service.stock_price_ingestion.uri
}

output "service_name" {
  description = "Name of the Cloud Run service"
  value       = google_cloud_run_v2_service.stock_price_ingestion.name
}

output "service_account_email" {
  description = "Email of the service account"
  value       = google_service_account.stock_price_ingestion.email
}

output "daily_sync_job_name" {
  description = "Name of the daily sync Cloud Scheduler job"
  value       = google_cloud_scheduler_job.daily_sync.name
}

output "weekly_backfill_job_name" {
  description = "Name of the weekly backfill Cloud Scheduler job"
  value       = google_cloud_scheduler_job.weekly_backfill.name
}

