/**
 * Market Data API Service Module
 *
 * Manages:
 * - Cloud Run service for the market data API (Connect-RPC on port 8090)
 * - Service account and IAM permissions
 * - Secret Manager references (DATABASE_URL)
 */

locals {
  service_name = "market-data"
  labels = {
    service     = "market-data"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run service
resource "google_service_account" "market_data" {
  account_id   = local.service_name
  display_name = "Market Data API Service"
  description  = "Service account for the market data Connect-RPC API"
  project      = var.project_id
}

# Grant Secret Manager access to service account
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.market_data.email}"
  project   = var.project_id
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "market_data" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.market_data.email

    containers {
      image = var.image_url

      ports {
        container_port = 8090
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
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = "DATABASE_URL"
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8090
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8090
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
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url
  ]
}

# Allow unauthenticated access (frontend calls this service)
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  name     = google_cloud_run_v2_service.market_data.name
  location = google_cloud_run_v2_service.market_data.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}
