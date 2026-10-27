output "service_url" {
  description = "Public run.app URL of the ingest service. Rigs set SHORTED_INGEST_URL to this, not an api.shorted.com.au path."
  value       = google_cloud_run_v2_service.ingest.uri
}

output "service_name" {
  description = "Name of the ingest Cloud Run service"
  value       = google_cloud_run_v2_service.ingest.name
}

output "service_account_email" {
  description = "Runtime service account of the ingest service"
  value       = google_service_account.ingest.email
}
