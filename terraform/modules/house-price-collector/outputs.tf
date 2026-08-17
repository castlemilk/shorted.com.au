output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.collector.name
}

output "service_account_email" {
  description = "Email of the collector job's service account"
  value       = google_service_account.collector.email
}

output "scheduler_job_name" {
  description = "Name of the monthly Cloud Scheduler job"
  value       = google_cloud_scheduler_job.monthly.name
}

output "drop_index_scheduler_job_name" {
  description = "Name of the daily drop-index Cloud Scheduler job"
  value       = google_cloud_scheduler_job.daily_drop_index.name
}
