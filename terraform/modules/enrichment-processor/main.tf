/**
 * Enrichment Processor Module
 * 
 * Manages:
 * - Pub/Sub topic and subscription for enrichment jobs
 * - Cloud Run Job for processing enrichment jobs
 * - Service account and IAM permissions
 */

locals {
  service_name = var.topic_name_suffix != "" ? "enrichment-processor-${var.topic_name_suffix}" : "enrichment-processor"
  topic_name   = var.topic_name_suffix != "" ? "enrichment-jobs-${var.topic_name_suffix}" : "enrichment-jobs"
  subscription_name = var.topic_name_suffix != "" ? "enrichment-jobs-subscription-${var.topic_name_suffix}" : "enrichment-jobs-subscription"
  labels = {
    service     = "enrichment-processor"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Pub/Sub Topic for enrichment jobs
resource "google_pubsub_topic" "enrichment_jobs" {
  name    = local.topic_name
  project = var.project_id

  labels = local.labels
}

# Pub/Sub Subscription (pull - processor will poll)
resource "google_pubsub_subscription" "enrichment_jobs" {
  name    = local.subscription_name
  topic   = google_pubsub_topic.enrichment_jobs.name
  project = var.project_id

  ack_deadline_seconds = 600 # 10 minutes
  message_retention_duration = "86400s" # 24 hours

  labels = local.labels
}

# Service Account for the Cloud Run job
resource "google_service_account" "enrichment_processor" {
  account_id   = local.service_name
  display_name = "Enrichment Processor Job"
  description  = "Service account for processing enrichment jobs"
  project      = var.project_id
}


# Grant Pub/Sub Subscriber role to processor service account
resource "google_pubsub_subscription_iam_member" "processor_subscriber" {
  subscription = google_pubsub_subscription.enrichment_jobs.name
  role           = "roles/pubsub.subscriber"
  member         = "serviceAccount:${google_service_account.enrichment_processor.email}"
  project        = var.project_id
}

# Grant Secret Manager access to processor service account
resource "google_secret_manager_secret_iam_member" "postgres_password" {
  secret_id = "APP_STORE_POSTGRES_PASSWORD"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.enrichment_processor.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "openai_api_key" {
  secret_id = "OPENAI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.enrichment_processor.email}"
  project   = var.project_id
}


# Cloud Run Job (v2) for processing enrichment jobs
resource "google_cloud_run_v2_job" "enrichment_processor" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.enrichment_processor.email

      max_retries = 3
      timeout     = "600s" # 10 minutes per job

      containers {
        image = var.image_url

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }

        env {
          name  = "ENRICHMENT_PUBSUB_TOPIC"
          value = local.topic_name
        }

        env {
          name  = "ENRICHMENT_PUBSUB_SUBSCRIPTION"
          value = local.subscription_name
        }

        env {
          name  = "APP_STORE_POSTGRES_ADDRESS"
          value = var.postgres_address
        }

        env {
          name  = "APP_STORE_POSTGRES_DATABASE"
          value = var.postgres_database
        }

        env {
          name  = "APP_STORE_POSTGRES_USERNAME"
          value = var.postgres_username
        }

        env {
          name = "APP_STORE_POSTGRES_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "APP_STORE_POSTGRES_PASSWORD"
              version = "latest"
            }
          }
        }

        env {
          name = "OPENAI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = "OPENAI_API_KEY"
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "4"
            memory = "8Gi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.postgres_password,
    google_secret_manager_secret_iam_member.openai_api_key,
    google_pubsub_subscription_iam_member.processor_subscriber
  ]
}

