output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.short_data_sync.name
}

output "job_id" {
  description = "Full resource ID of the Cloud Run job"
  value       = google_cloud_run_v2_job.short_data_sync.id
}

output "service_account_email" {
  description = "Email of the service account"
  value       = google_service_account.short_data_sync.email
}

output "bucket_name" {
  description = "Name of the GCS bucket for short selling data"
  value       = google_storage_bucket.short_selling_data.name
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.daily_sync.name
}

