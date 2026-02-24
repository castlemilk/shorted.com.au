output "service_url" {
  description = "URL of the market-data Cloud Run service"
  value       = google_cloud_run_v2_service.market_data.uri
}

output "service_account_email" {
  description = "Email of the market-data service account"
  value       = google_service_account.market_data.email
}
