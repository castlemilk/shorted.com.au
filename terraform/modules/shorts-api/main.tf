/**
 * Shorts API Module
 * 
 * Manages:
 * - Cloud Run service for the Shorts API (Go service)
 * - Service account and IAM permissions
 * - Database connection configuration
 */

locals {
  service_name = "shorts"
  labels = {
    service     = "shorts-api"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run service
resource "google_service_account" "shorts_api" {
  account_id   = local.service_name
  display_name = "Shorts API Service"
  description  = "Service account for the Shorts API"
  project      = var.project_id
}

# Grant Secret Manager access to service account
resource "google_secret_manager_secret_iam_member" "postgres_password" {
  secret_id = "APP_STORE_POSTGRES_PASSWORD"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "shorts_api" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.shorts_api.email

    containers {
      image = var.image_url

      ports {
        container_port = 8080
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

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 30
        period_seconds        = 30
        timeout_seconds       = 5
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
    google_secret_manager_secret_iam_member.postgres_password
  ]
}

# Allow public access to the API
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  name     = google_cloud_run_v2_service.shorts_api.name
  location = google_cloud_run_v2_service.shorts_api.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

