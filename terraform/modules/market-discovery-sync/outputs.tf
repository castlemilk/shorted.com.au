output "market_data_sync_service_url" {
  description = "URL of the market data sync Cloud Run service"
  value       = google_cloud_run_v2_service.market_data_sync.uri
}

output "market_data_sync_service_name" {
  description = "Name of the market data sync Cloud Run service"
  value       = google_cloud_run_v2_service.market_data_sync.name
}

output "asx_discovery_job_name" {
  description = "Name of the ASX discovery Cloud Run job"
  value       = google_cloud_run_v2_job.asx_discovery.name
}
