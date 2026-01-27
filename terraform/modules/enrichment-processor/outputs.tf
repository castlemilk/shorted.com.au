output "topic_name" {
  description = "Name of the Pub/Sub topic"
  value       = google_pubsub_topic.enrichment_jobs.name
}

output "subscription_name" {
  description = "Name of the Pub/Sub subscription"
  value       = google_pubsub_subscription.enrichment_jobs.name
}

output "service_name" {
  description = "Name of the Cloud Run Service"
  value       = google_cloud_run_v2_service.enrichment_processor.name
}

output "service_url" {
  description = "URL of the Cloud Run Service"
  value       = google_cloud_run_v2_service.enrichment_processor.uri
}

output "service_account_email" {
  description = "Email of the enrichment processor service account"
  value       = google_service_account.enrichment_processor.email
}
