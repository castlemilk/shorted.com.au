/**
 * CMS Module (Payload CMS)
 * 
 * Manages:
 * - Cloud Run service for Payload CMS
 * - Service account and IAM permissions
 * - PostgreSQL database connection configuration
 */

locals {
  service_name         = "cms"
  service_account_name = "shorted-cms" # Min 6 chars for GCP service account
  labels = {
    service     = "cms"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run service
resource "google_service_account" "cms" {
  account_id   = local.service_account_name
  display_name = "CMS Service"
  description  = "Service account for Payload CMS"
  project      = var.project_id
}

# Grant Secret Manager access to service account for DATABASE_URL
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = var.database_url_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cms.email}"
  project   = var.project_id
}

# Grant access to PAYLOAD_SECRET
resource "google_secret_manager_secret_iam_member" "payload_secret" {
  secret_id = "PAYLOAD_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cms.email}"
  project   = var.project_id
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "cms" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.cms.email

    containers {
      image = var.image_url

      ports {
        container_port = 3002
        name           = "http1"
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "NODE_ENV"
        value = var.environment == "production" ? "production" : "development"
      }

      env {
        name  = "PAYLOAD_CONFIG_PATH"
        value = "dist/payload.config.js"
      }

      # Payload CMS secret key (required for security)
      env {
        name = "PAYLOAD_SECRET"
        value_source {
          secret_key_ref {
            secret  = "PAYLOAD_SECRET"
            version = "latest"
          }
        }
      }

      # PostgreSQL connection (Payload CMS uses DATABASE_URI)
      env {
        name = "DATABASE_URI"
        value_source {
          secret_key_ref {
            secret  = var.database_url_secret_name
            version = "latest"
          }
        }
      }

      # Additional environment variables
      dynamic "env" {
        for_each = var.additional_env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/admin"
          port = 3002
        }
        initial_delay_seconds = 15
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 6  # Allow more retries for Payload startup
      }

      liveness_probe {
        http_get {
          path = "/admin"
          port = 3002
        }
        initial_delay_seconds = 30
        period_seconds        = 30
        timeout_seconds       = 10
        failure_threshold     = 3
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    timeout = "300s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.payload_secret
  ]
}

# IAM policy for accessing the CMS
resource "google_cloud_run_v2_service_iam_member" "cms_access" {
  name     = google_cloud_run_v2_service.cms.name
  location = google_cloud_run_v2_service.cms.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = var.allow_unauthenticated ? "allUsers" : "serviceAccount:${google_service_account.cms.email}"
}
