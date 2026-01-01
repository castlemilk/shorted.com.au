output "topic_name" {
  description = "Name of the Pub/Sub topic"
  value       = google_pubsub_topic.enrichment_jobs.name
}

output "subscription_name" {
  description = "Name of the Pub/Sub subscription"
  value       = google_pubsub_subscription.enrichment_jobs.name
}

output "job_name" {
  description = "Name of the Cloud Run Job"
  value       = google_cloud_run_v2_job.enrichment_processor.name
}

