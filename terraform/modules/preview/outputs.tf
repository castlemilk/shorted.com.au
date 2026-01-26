output "shorts_url" {
  description = "URL of the shorts API service"
  value       = google_cloud_run_v2_service.shorts_preview.uri
}

output "market_data_url" {
  description = "URL of the market data service"
  value       = google_cloud_run_v2_service.market_data_preview.uri
}

output "shorts_service_name" {
  description = "Name of the shorts service"
  value       = google_cloud_run_v2_service.shorts_preview.name
}

output "market_data_service_name" {
  description = "Name of the market data service"
  value       = google_cloud_run_v2_service.market_data_preview.name
}

output "enrichment_processor_url" {
  description = "URL of the enrichment processor service"
  value       = google_cloud_run_v2_service.enrichment_processor_preview.uri
}
