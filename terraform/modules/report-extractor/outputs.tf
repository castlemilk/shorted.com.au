output "director_job_name" {
  description = "Name of the director-trade-extractor Cloud Run job"
  value       = google_cloud_run_v2_job.director_trade_extractor.name
}

output "reports_job_name" {
  description = "Name of the financial-report-extractor Cloud Run job"
  value       = google_cloud_run_v2_job.financial_report_extractor.name
}

output "service_account_email" {
  description = "Email of the shared job service account"
  value       = google_service_account.report_extractor.email
}

output "director_scheduler_job_name" {
  value = google_cloud_scheduler_job.director_trade_extractor.name
}

output "reports_scheduler_job_name" {
  value = google_cloud_scheduler_job.financial_report_extractor.name
}
