output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.job.name
}

output "service_account_email" {
  description = "Email of the job's service account"
  value       = google_service_account.job.email
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job; null when the job has no schedule"
  value       = one(google_cloud_scheduler_job.schedule[*].name)
}

output "extra_scheduler_job_names" {
  description = "Names of the additional Cloud Scheduler jobs (var.schedules), keyed by name_suffix"
  value       = { for k, s in google_cloud_scheduler_job.extra_schedule : k => s.name }
}

output "extra_schedulers_paused" {
  description = "Paused state of each additional Cloud Scheduler job, keyed by name_suffix"
  value       = { for k, s in google_cloud_scheduler_job.extra_schedule : k => s.paused }
}

output "scheduler_paused" {
  description = "Whether the Cloud Scheduler job is paused; null when the job has no schedule"
  value       = one(google_cloud_scheduler_job.schedule[*].paused)
}
