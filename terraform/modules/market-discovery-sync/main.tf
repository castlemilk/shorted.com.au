locals {
  labels = {
    module      = "market-discovery-sync"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for ASX Discovery
resource "google_service_account" "asx_discovery" {
  account_id   = "asx-discovery"
  display_name = "ASX Discovery Job SA"
  project      = var.project_id
}

# Grant GCS access to ASX Discovery
resource "google_storage_bucket_iam_member" "asx_discovery_gcs" {
  bucket = var.bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.asx_discovery.email}"
}

# ASX Discovery Cloud Run Job
resource "google_cloud_run_v2_job" "asx_discovery" {
  name     = "asx-discovery"
  location = var.region
  project  = var.project_id

  template {
    template {
      service_account = google_service_account.asx_discovery.email
      containers {
        image = var.asx_discovery_image
        
        env {
          name  = "GCS_BUCKET_NAME"
          value = var.bucket_name
        }
        
        resources {
          limits = {
            cpu    = "1"
            memory = "2Gi"
          }
        }
      }
    }
  }
}

# Service Account for Market Data Sync
resource "google_service_account" "market_data_sync" {
  account_id   = "market-data-sync"
  display_name = "Market Data Sync Service SA"
  project      = var.project_id
}

# Grant GCS access to Market Data Sync
resource "google_storage_bucket_iam_member" "market_data_sync_gcs" {
  bucket = var.bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.market_data_sync.email}"
}

# Grant Secret Manager access to Market Data Sync
resource "google_secret_manager_secret_iam_member" "market_data_sync_db" {
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.market_data_sync.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "market_data_sync_av" {
  secret_id = var.alpha_vantage_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.market_data_sync.email}"
  project   = var.project_id
}

# Market Data Sync Cloud Run Service (HTTP API)
resource "google_cloud_run_v2_service" "market_data_sync" {
  name     = "market-data-sync"
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.market_data_sync.email

    containers {
      image = var.market_data_sync_image

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
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_url_secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "GCS_BUCKET_NAME"
        value = var.bucket_name
      }

      env {
        name  = "PRIORITY_STOCK_COUNT"
        value = "100"
      }

      env {
        name = "ALPHA_VANTAGE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.alpha_vantage_api_key_secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "2Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
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

    timeout = "600s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.market_data_sync_db,
    google_secret_manager_secret_iam_member.market_data_sync_av,
    google_storage_bucket_iam_member.market_data_sync_gcs
  ]
}

# Allow public access to the API (or restrict as needed)
resource "google_cloud_run_v2_service_iam_member" "market_data_sync_public" {
  name     = google_cloud_run_v2_service.market_data_sync.name
  location = google_cloud_run_v2_service.market_data_sync.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Scheduler Service Account
resource "google_service_account" "scheduler" {
  account_id   = "market-jobs-scheduler"
  display_name = "Market Jobs Scheduler SA"
  project      = var.project_id
}

# Grant Invoker permissions to Scheduler
resource "google_cloud_run_v2_job_iam_member" "asx_discovery_invoker" {
  name     = google_cloud_run_v2_job.asx_discovery.name
  location = google_cloud_run_v2_job.asx_discovery.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
  project  = var.project_id
}

# Note: Market Data Sync is now a Service (not Job), so it doesn't need scheduler invoker
# It can be triggered via HTTP API calls instead

# Weekly ASX Discovery Scheduler (Sunday 10PM AEST = 12PM UTC)
resource "google_cloud_scheduler_job" "asx_discovery_weekly" {
  name             = "asx-discovery-weekly"
  description      = "Download ASX company directory CSV weekly"
  schedule         = "0 12 * * 0"
  time_zone        = "UTC"
  attempt_deadline = "320s"
  project          = var.project_id
  region           = var.scheduler_region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.asx_discovery.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

# Daily Market Data Sync Scheduler (Mon-Fri 8PM AEST = 10AM UTC)
# Triggers full sync via HTTP API
resource "google_cloud_scheduler_job" "market_data_sync_daily" {
  name             = "market-data-sync-daily"
  description      = "Sync stock prices daily via HTTP API"
  schedule         = "0 10 * * 1-5"
  time_zone        = "UTC"
  attempt_deadline = "3600s"
  project          = var.project_id
  region           = var.scheduler_region

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.market_data_sync.uri}/api/sync/all"
    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [
    google_cloud_run_v2_service.market_data_sync
  ]
}

# Grant scheduler service account permission to invoke the service
resource "google_cloud_run_v2_service_iam_member" "market_data_sync_scheduler_invoker" {
  name     = google_cloud_run_v2_service.market_data_sync.name
  location = google_cloud_run_v2_service.market_data_sync.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
