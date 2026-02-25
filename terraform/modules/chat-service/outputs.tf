output "service_url" {
  description = "URL of the Chat Service Cloud Run service"
  value       = google_cloud_run_v2_service.chat_service.uri
}

output "service_name" {
  description = "Name of the Chat Service Cloud Run service"
  value       = google_cloud_run_v2_service.chat_service.name
}

output "service_account_email" {
  description = "Email of the Chat Service service account"
  value       = google_service_account.chat_service.email
}
