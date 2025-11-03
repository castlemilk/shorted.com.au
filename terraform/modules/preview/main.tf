/**
 * Preview Environment Module
 * 
 * Creates ephemeral preview environments for PRs
 * - Lightweight versions of services (no schedulers, no sync jobs)
 * - Tagged with PR number for easy cleanup
 * - Uses same service accounts as dev for simplicity
 */

locals {
  pr_suffix = "pr-${var.pr_number}"
  labels = {
    environment = "preview"
    managed_by  = "terraform"
    pr_number   = var.pr_number
    type        = "preview"
  }
}

# Shorts API Preview
resource "google_cloud_run_v2_service" "shorts_preview" {
  name     = "shorts-service-${local.pr_suffix}"
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = var.shorts_service_account

    containers {
      image = var.shorts_api_image
      
      ports {
        container_port = 8080
      }

      env {
        name  = "ENVIRONMENT"
        value = "preview"
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
            secret  = var.postgres_password_secret_name
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Make Shorts API publicly accessible
resource "google_cloud_run_v2_service_iam_member" "shorts_preview_access" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.shorts_preview.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Market Data Service Preview
resource "google_cloud_run_v2_service" "market_data_preview" {
  name     = "market-data-service-${local.pr_suffix}"
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = var.shorts_service_account  # Reuse shorts SA for preview

    containers {
      image = var.market_data_image
      
      ports {
        container_port = 8090
      }

      env {
        name  = "ENVIRONMENT"
        value = "preview"
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
            secret  = var.postgres_password_secret_name
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Make Market Data API publicly accessible
resource "google_cloud_run_v2_service_iam_member" "market_data_preview_access" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.market_data_preview.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

