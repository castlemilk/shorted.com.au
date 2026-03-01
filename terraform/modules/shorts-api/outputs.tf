output "service_url" {
  description = "URL of the deployed Cloud Run service"
  value       = google_cloud_run_v2_service.shorts_api.uri
}

output "service_name" {
  description = "Name of the Cloud Run service"
  value       = google_cloud_run_v2_service.shorts_api.name
}

output "service_account_email" {
  description = "Email of the service account"
  value       = google_service_account.shorts_api.email
}

output "custom_domain_dns_records" {
  description = "DNS records required for custom domain mapping (CNAME to ghs.googlehosted.com)"
  value       = var.custom_domain != "" ? google_cloud_run_domain_mapping.api_domain[0].status[0].resource_records : []
}

