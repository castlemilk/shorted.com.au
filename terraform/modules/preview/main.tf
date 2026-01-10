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

# Allow the preview Shorts service account to read the OpenAI API key secret.
resource "google_secret_manager_secret_iam_member" "openai_api_key" {
  project   = var.project_id
  secret_id = "OPENAI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.shorts_service_account}"
}

# Shorts API Preview
resource "google_cloud_run_v2_service" "shorts_preview" {
  name     = "shorts-service-${local.pr_suffix}"
  location = var.region
  project  = var.project_id

  labels = local.labels

  depends_on = [
    google_secret_manager_secret_iam_member.openai_api_key,
  ]

  lifecycle {
    create_before_destroy = true
    # Ignore changes to revision and other computed attributes that can cause
    # "present but now absent" errors during updates
    ignore_changes = [
      template[0].revision,
      template[0].labels,
      client,
      client_version,
      # Ignore traffic changes to avoid conflicts with services created by gcloud
      traffic,
    ]
  }

  template {
    service_account = var.shorts_service_account

    containers {
      image = var.shorts_api_image

      ports {
        container_port = 9091
      }

      # Env vars in alphabetical order to prevent reordering diffs
      env {
        name = "ALGOLIA_APP_ID"
        value_source {
          secret_key_ref {
            secret  = "ALGOLIA_APP_ID"
            version = "latest"
          }
        }
      }

      env {
        name  = "ALGOLIA_INDEX"
        value = "stocks"
      }

      env {
        name = "ALGOLIA_SEARCH_KEY"
        value_source {
          secret_key_ref {
            secret  = "ALGOLIA_SEARCH_KEY"
            version = "latest"
          }
        }
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
        name = "APP_STORE_POSTGRES_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = var.postgres_password_secret_name
            version = "latest"
          }
        }
      }

      # Algolia Search Configuration
      env {
        name  = "APP_STORE_POSTGRES_USERNAME"
        value = var.postgres_username
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

  depends_on = [
    google_cloud_run_v2_service.shorts_preview
  ]
}

# Market Data Service Preview
resource "google_cloud_run_v2_service" "market_data_preview" {
  name     = "market-data-service-${local.pr_suffix}"
  location = var.region
  project  = var.project_id

  labels = local.labels

  lifecycle {
    create_before_destroy = true
    # Ignore changes to revision and other computed attributes that can cause
    # "present but now absent" errors during updates
    ignore_changes = [
      template[0].revision,
      template[0].labels,
      client,
      client_version,
      # Ignore traffic changes to avoid conflicts with services created by gcloud
      traffic,
    ]
  }

  template {
    service_account = var.shorts_service_account # Reuse shorts SA for preview

    containers {
      image = var.market_data_image

      ports {
        container_port = 8090
      }

      # Env vars in alphabetical order to prevent reordering diffs
      env {
        name  = "APP_STORE_POSTGRES_ADDRESS"
        value = var.postgres_address
      }

      env {
        name  = "APP_STORE_POSTGRES_DATABASE"
        value = var.postgres_database
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

      env {
        name  = "APP_STORE_POSTGRES_USERNAME"
        value = var.postgres_username
      }

      # Market-data service expects DATABASE_URL
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = "DATABASE_URL"
            version = "latest"
          }
        }
      }

      env {
        name  = "ENVIRONMENT"
        value = "preview"
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
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

  depends_on = [
    google_cloud_run_v2_service.market_data_preview
  ]
}

# NOTE: DATABASE_URL secret access must be granted manually to the shorts service account:
# gcloud secrets add-iam-policy-binding DATABASE_URL \
#   --project=shorted-dev-aba5688f \
#   --member="serviceAccount:shorts@shorted-dev-aba5688f.iam.gserviceaccount.com" \
#   --role="roles/secretmanager.secretAccessor"
