locals {
  labels = {
    module      = "market-discovery-sync"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Jobs-monolith cutover: an empty override keeps the legacy per-service image,
  # so the module's default behaviour (and every un-migrated call site) is
  # byte-identical to before this variable existed.
  asx_discovery_image    = var.asx_discovery_image_override != "" ? var.asx_discovery_image_override : var.asx_discovery_image
  market_data_sync_image = var.market_data_sync_image_override != "" ? var.market_data_sync_image_override : var.market_data_sync_image

  # `null` (not `[]`) so the attribute is OMITTED and the image's own
  # ENTRYPOINT/CMD applies — an empty list would clear it.
  #
  # command/args are COUPLED to the image override: clearing just the image
  # override (the advertised one-variable rollback) must also drop the
  # `/shorted` command, or the legacy image (which has no /shorted binary)
  # crash-loops with `exec: "/shorted": not found` — the rollback would BE
  # the outage. With the override unset, command/args are null regardless of
  # the *_command/*_args vars.
  asx_discovery_command    = var.asx_discovery_image_override != "" && length(var.asx_discovery_command) > 0 ? var.asx_discovery_command : null
  asx_discovery_args       = var.asx_discovery_image_override != "" && length(var.asx_discovery_args) > 0 ? var.asx_discovery_args : null
  market_data_sync_command = var.market_data_sync_image_override != "" && length(var.market_data_sync_command) > 0 ? var.market_data_sync_command : null
  market_data_sync_args    = var.market_data_sync_image_override != "" && length(var.market_data_sync_args) > 0 ? var.market_data_sync_args : null
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
        image   = local.asx_discovery_image
        command = local.asx_discovery_command
        args    = local.asx_discovery_args

        env {
          name  = "GCS_BUCKET_NAME"
          value = var.bucket_name
        }

        # DOWNLOAD_DIR is otherwise left to the image's own ENV default
        # (/tmp/asx-downloads in BOTH the legacy asx-discovery image and
        # services/jobs/Dockerfile.browser), exactly as before.
        dynamic "env" {
          for_each = var.asx_discovery_download_dir != "" ? [var.asx_discovery_download_dir] : []
          content {
            name  = "DOWNLOAD_DIR"
            value = env.value
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
          # asx-discovery drives a headless Chromium (Playwright) to scrape ASX
          # listings. At 1Gi every weekly run OOM-killed ("configured memory limit
          # was reached") — headless Chrome needs several GB, and the job also
          # transiently re-downloads a ~165 MiB Chromium at startup. 4Gi/2 CPU gives
          # comfortable headroom; the job runs weekly for a couple of minutes, so the
          # cost is negligible. (Follow-up: bundle the browser at the playwright-go
          # version so it stops re-downloading at runtime.)
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.asx_discovery_otel_headers
  ]
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

# Grant access to OpenTelemetry OTLP headers secret (ASX Discovery)
resource "google_secret_manager_secret_iam_member" "asx_discovery_otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.asx_discovery.email}"
  project   = var.project_id
}

# Grant access to OpenTelemetry OTLP headers secret (Market Data Sync)
resource "google_secret_manager_secret_iam_member" "market_data_sync_otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
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
      image   = local.market_data_sync_image
      command = local.market_data_sync_command
      args    = local.market_data_sync_args

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
        name  = "DB_MAX_CONNS"
        value = "3"
      }

      env {
        name  = "DB_MIN_CONNS"
        value = "0"
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
          memory = "512Mi"
        }
        cpu_idle          = true # Throttle CPU when idle to reduce costs
        startup_cpu_boost = true
      }

      # Probe parity across the cutover: `shorted market-data serve` registers
      # /healthz, /readyz AND /health (marketdata/api/server.go) before its
      # dependencies come up, and listens on $PORT (default 8080), which Cloud
      # Run sets to the container port declared above. Both probe paths/ports are
      # therefore unchanged — do not "modernise" them to /healthz without
      # re-checking the legacy image.
      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 5
        failure_threshold     = 6
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
    google_secret_manager_secret_iam_member.market_data_sync_db,
    google_secret_manager_secret_iam_member.market_data_sync_av,
    google_secret_manager_secret_iam_member.market_data_sync_otel_headers,
    google_storage_bucket_iam_member.market_data_sync_gcs
  ]
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
  attempt_deadline = "1800s" # Max allowed is 30 minutes
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
      audience              = google_cloud_run_v2_service.market_data_sync.uri
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
