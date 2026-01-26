/**
 * Stock Price Ingestion Service Module
 * 
 * Manages:
 * - Cloud Run service for stock price ingestion
 * - Cloud Scheduler jobs (daily sync, weekly backfill)
 * - Service account and IAM permissions
 * - Secret Manager references
 */

locals {
  service_name = "stock-price-ingestion"
  labels = {
    service     = "stock-price-ingestion"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run service
resource "google_service_account" "stock_price_ingestion" {
  account_id   = local.service_name
  display_name = "Stock Price Ingestion Service"
  description  = "Service account for stock price data ingestion from Alpha Vantage and Yahoo Finance"
  project      = var.project_id
}

# Grant Secret Manager access to service account
resource "google_secret_manager_secret_iam_member" "alpha_vantage_api_key" {
  secret_id = "ALPHA_VANTAGE_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.stock_price_ingestion.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.stock_price_ingestion.email}"
  project   = var.project_id
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "stock_price_ingestion" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    service_account = google_service_account.stock_price_ingestion.email

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
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = "DATABASE_URL"
            version = "latest"
          }
        }
      }

      env {
        name = "ALPHA_VANTAGE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = "ALPHA_VANTAGE_API_KEY"
            version = "latest"
          }
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
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
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
    google_secret_manager_secret_iam_member.alpha_vantage_api_key,
    google_secret_manager_secret_iam_member.database_url
  ]
}

# Allow unauthenticated access (for Cloud Scheduler)
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.stock_price_ingestion.name
  location = google_cloud_run_v2_service.stock_price_ingestion.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Cloud Scheduler Job - Daily Sync
resource "google_cloud_scheduler_job" "daily_sync" {
  name             = "stock-price-daily-sync" # Keep existing job name
  description      = "Daily sync of ASX stock prices from Yahoo Finance (after market close)"
  schedule         = "0 8 * * 1-5" # Weekdays at 6 PM AEST (8 AM UTC)
  time_zone        = "UTC"
  attempt_deadline = "600s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 3
    max_retry_duration   = "3600s"
    min_backoff_duration = "5s"
    max_backoff_duration = "3600s"
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.stock_price_ingestion.uri}/sync-all"
    body        = base64encode("{}")

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = google_service_account.stock_price_ingestion.email
    }
  }

  depends_on = [google_cloud_run_v2_service.stock_price_ingestion]
}

# Cloud Scheduler Job - Weekly Backfill
resource "google_cloud_scheduler_job" "weekly_backfill" {
  name             = "stock-price-weekly-sync" # Keep existing job name
  description      = "Weekly comprehensive sync of stock prices (7-day backfill)"
  schedule         = "0 10 * * 0" # Sundays at 8 PM AEST (10 AM UTC)
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 2
    max_retry_duration   = "7200s"
    min_backoff_duration = "10s"
    max_backoff_duration = "7200s"
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.stock_price_ingestion.uri}/sync"
    body = base64encode(jsonencode({
      days_back = 7
      mode      = "backfill"
    }))

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = google_service_account.stock_price_ingestion.email
    }
  }

  depends_on = [google_cloud_run_v2_service.stock_price_ingestion]
}

