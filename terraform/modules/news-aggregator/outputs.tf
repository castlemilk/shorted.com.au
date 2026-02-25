output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.news_aggregator.name
}

output "job_id" {
  description = "Full resource ID of the Cloud Run job"
  value       = google_cloud_run_v2_job.news_aggregator.id
}

output "service_account_email" {
  description = "Email of the service account"
  value       = google_service_account.news_aggregator.email
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.news_aggregator.name
}
