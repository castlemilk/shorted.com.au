output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.job.name
}

output "service_account_email" {
  description = "Email of the job's service account"
  value       = google_service_account.job.email
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.schedule.name
}

output "scheduler_paused" {
  description = "Whether the Cloud Scheduler job is paused"
  value       = google_cloud_scheduler_job.schedule.paused
}
