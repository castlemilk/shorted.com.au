/**
 * Enrichment Processor Module
 * 
 * Manages:
 * - Pub/Sub topic and subscription for enrichment jobs
 * - Cloud Run Service for processing enrichment jobs (runs continuously)
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


# Cloud Run Service (v2) for processing enrichment jobs
# Runs continuously and polls Pub/Sub subscription for jobs
resource "google_cloud_run_v2_service" "enrichment_processor" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.enrichment_processor.email

    containers {
      image = var.image_url

      ports {
        container_port = 8080
        name           = "http1"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "IMAGE_TAG"
        value = var.image_tag # Forces new revision when image is rebuilt
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

      env {
        name  = "GCS_LOGO_BUCKET"
        value = "shorted-company-logos"
      }

      resources {
        limits = {
          cpu    = "4"
          memory = "8Gi"
        }
        cpu_idle          = true # Allow CPU to scale down when idle
        startup_cpu_boost = true
      }
    }

    scaling {
      min_instance_count = 1  # Keep one instance warm for processing jobs
      max_instance_count = 5  # Allow scaling for concurrent jobs
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.postgres_password,
    google_secret_manager_secret_iam_member.openai_api_key,
    google_pubsub_subscription_iam_member.processor_subscriber
  ]
}

# IAM binding for Cloud Run invoker (internal use only)
resource "google_cloud_run_v2_service_iam_member" "enrichment_processor_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.enrichment_processor.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.enrichment_processor.email}"

  depends_on = [
    google_cloud_run_v2_service.enrichment_processor
  ]
}

