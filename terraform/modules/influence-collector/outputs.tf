output "job_name" {
  description = "Name of the Cloud Run job"
  value       = google_cloud_run_v2_job.collector.name
}

output "service_account_email" {
  description = "Email of the collector job's service account"
  value       = google_service_account.collector.email
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.monthly.name
}

output "register_bucket_name" {
  description = "Private bucket holding fetched APH register PDFs (empty when unmanaged)"
  value       = var.manage_register_bucket ? google_storage_bucket.register[0].name : ""
}
