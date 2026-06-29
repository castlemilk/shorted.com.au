output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.signals_collector.name
}

output "job_id" {
  description = "Full resource ID of the Cloud Run job"
  value       = google_cloud_run_v2_job.signals_collector.id
}

output "service_account_email" {
  description = "Email of the job service account"
  value       = google_service_account.signals_collector.email
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.signals_collector.name
}
