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

# Grant access to Algolia secrets
resource "google_secret_manager_secret_iam_member" "algolia_app_id" {
  secret_id = "ALGOLIA_APP_ID"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "algolia_search_key" {
  secret_id = "ALGOLIA_SEARCH_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Grant access to Algolia admin key secret (for post-enrichment Algolia sync)
resource "google_secret_manager_secret_iam_member" "algolia_admin_key" {
  secret_id = "ALGOLIA_ADMIN_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Grant access to OpenAI API key secret (for enrichment)
resource "google_secret_manager_secret_iam_member" "openai_api_key" {
  secret_id = "OPENAI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Grant access to internal service secret (for webhook auth from frontend)
resource "google_secret_manager_secret_iam_member" "internal_service_secret" {
  secret_id = "INTERNAL_SERVICE_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Grant access to token secret (for API token JWT signing)
resource "google_secret_manager_secret_iam_member" "token_secret" {
  secret_id = "TOKEN_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# OpenTelemetry OTLP headers secret (contains Grafana Cloud auth token)
resource "google_secret_manager_secret" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  project   = var.project_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = google_secret_manager_secret.otel_headers.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}

# Grant Pub/Sub Publisher role to shorts API service account (for publishing enrichment jobs)
resource "google_pubsub_topic_iam_member" "enrichment_jobs_publisher" {
  topic    = "enrichment-jobs"
  role     = "roles/pubsub.publisher"
  member   = "serviceAccount:${google_service_account.shorts_api.email}"
  project  = var.project_id
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
        container_port = 9091
        name           = "http1"
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "GCP_PROJECT_ID"
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

      # Algolia Search Configuration
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
        name = "ALGOLIA_SEARCH_KEY"
        value_source {
          secret_key_ref {
            secret  = "ALGOLIA_SEARCH_KEY"
            version = "latest"
          }
        }
      }

      env {
        name = "ALGOLIA_ADMIN_KEY"
        value_source {
          secret_key_ref {
            secret  = "ALGOLIA_ADMIN_KEY"
            version = "latest"
          }
        }
      }

      env {
        name  = "ALGOLIA_INDEX"
        value = "stocks"
      }

      # OpenAI enrichment
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = "OPENAI_API_KEY"
            version = "latest"
          }
        }
      }

      # Internal service authentication (for webhook/server action calls from frontend)
      env {
        name = "INTERNAL_SERVICE_SECRET"
        value_source {
          secret_key_ref {
            secret  = "INTERNAL_SERVICE_SECRET"
            version = "latest"
          }
        }
      }

      # API token JWT signing secret
      env {
        name = "TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = "TOKEN_SECRET"
            version = "latest"
          }
        }
      }

      # OpenTelemetry configuration (traces + metrics to Grafana Cloud)
      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = var.otel_endpoint
      }

      env {
        name  = "OTEL_EXPORTER_OTLP_PROTOCOL"
        value = "http/protobuf"
      }

      env {
        name = "OTEL_EXPORTER_OTLP_HEADERS"
        value_source {
          secret_key_ref {
            secret  = "OTEL_EXPORTER_OTLP_HEADERS"
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true  # Throttle CPU when idle to reduce costs
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 9091
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 9091
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
    google_secret_manager_secret_iam_member.postgres_password,
    google_secret_manager_secret_iam_member.algolia_app_id,
    google_secret_manager_secret_iam_member.algolia_search_key,
    google_secret_manager_secret_iam_member.algolia_admin_key,
    google_secret_manager_secret_iam_member.openai_api_key,
    google_secret_manager_secret_iam_member.internal_service_secret,
    google_secret_manager_secret_iam_member.token_secret,
    google_secret_manager_secret_iam_member.otel_headers
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

# --- Key Metrics Daily Sync Scheduler ---

# Service account for the scheduler to invoke the shorts API
resource "google_service_account" "key_metrics_scheduler" {
  count        = var.enable_key_metrics_scheduler ? 1 : 0
  account_id   = "key-metrics-scheduler"
  display_name = "Key Metrics Scheduler"
  description  = "Service account for Cloud Scheduler to trigger daily key metrics sync"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_service_iam_member" "key_metrics_scheduler_invoker" {
  count    = var.enable_key_metrics_scheduler ? 1 : 0
  name     = google_cloud_run_v2_service.shorts_api.name
  location = google_cloud_run_v2_service.shorts_api.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.key_metrics_scheduler[0].email}"
}

# Read the internal service secret for key-metrics scheduler auth
data "google_secret_manager_secret_version" "internal_service_secret" {
  count   = var.enable_key_metrics_scheduler ? 1 : 0
  secret  = "INTERNAL_SERVICE_SECRET"
  project = var.project_id
}

# Grant Secret Manager access to the key-metrics scheduler SA
resource "google_secret_manager_secret_iam_member" "key_metrics_secret_access" {
  count     = var.enable_key_metrics_scheduler ? 1 : 0
  secret_id = "INTERNAL_SERVICE_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.key_metrics_scheduler[0].email}"
  project   = var.project_id
}

# Cloud Scheduler Job - Daily Key Metrics Sync at 3 AM AEST (5 PM UTC previous day)
resource "google_cloud_scheduler_job" "key_metrics_daily" {
  count            = var.enable_key_metrics_scheduler ? 1 : 0
  name             = "key-metrics-daily-sync"
  description      = "Daily sync of key financial metrics for all stocks"
  schedule         = "0 17 * * *" # 3 AM AEST (5 PM UTC previous day)
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 2
    max_retry_duration   = "3600s"
    min_backoff_duration = "30s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.shorts_api.uri}/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics"
    body        = base64encode("{}")

    headers = {
      "Content-Type"      = "application/json"
      "x-internal-secret" = data.google_secret_manager_secret_version.internal_service_secret[0].secret_data
      "x-user-email"      = "scheduler@shorted.com.au"
      "x-user-id"         = "scheduler"
      "x-user-roles"      = "admin"
    }

    oidc_token {
      service_account_email = google_service_account.key_metrics_scheduler[0].email
      audience              = google_cloud_run_v2_service.shorts_api.uri
    }
  }

  depends_on = [
    google_cloud_run_v2_service.shorts_api,
    google_cloud_run_v2_service_iam_member.key_metrics_scheduler_invoker,
    google_secret_manager_secret_iam_member.key_metrics_secret_access
  ]
}

