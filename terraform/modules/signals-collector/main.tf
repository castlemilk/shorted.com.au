/**
 * Signals Collector Module
 *
 * Manages:
 * - Cloud Run Job that calls brandbrain ResolveBusinessSignals and upserts stock_signals
 * - Service account and IAM permissions (DATABASE_URL + OTEL secrets)
 * - Cloud Scheduler job (weekly)
 *
 * brandbrain runs on a single instance and 502s above ~2 concurrent grounded calls, so
 * the job is pinned to --workers 2 with a bounded --limit per sweep. Raising throughput
 * is gated on brandbrain horizontal scale (docs/enrichment-architecture.md §6.10).
 */

locals {
  service_name = "signals-collector"
  labels = {
    service     = "signals-collector"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "signals_collector" {
  account_id   = local.service_name
  display_name = "Signals Collector"
  description  = "Service account for the brandbrain risk/reputation signals collector"
  project      = var.project_id
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.signals_collector.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.signals_collector.email}"
  project   = var.project_id
}

resource "google_cloud_run_v2_job" "signals_collector" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.signals_collector.email

      max_retries = 2
      timeout     = "3600s" # 1 hour; bounded --limit keeps a sweep well within this

      containers {
        image = var.image_url

        # workers=2: brandbrain single-instance 502s above ~2 concurrent grounded calls.
        args = ["--priority", "top-shorted", "--limit", tostring(var.sweep_limit), "--max-age-days", tostring(var.max_age_days), "--workers", "2"]

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "BRANDBRAIN_URL"
          value = var.brandbrain_url
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
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.otel_headers,
  ]
}

resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-sched"
  display_name = "Signals Collector Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the signals collector"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.signals_collector.name
  location = google_cloud_run_v2_job.signals_collector.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Weekly — each sweep is expensive brandbrain-grounded research; skip-fresh (--max-age-days)
# means most stocks are skipped between sweeps anyway.
resource "google_cloud_scheduler_job" "signals_collector" {
  name             = "${local.service_name}-weekly"
  description      = "Weekly sweep of risk/reputation signals for top-shorted stocks via brandbrain"
  schedule         = var.schedule
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.scheduler_paused

  retry_config {
    retry_count          = 1
    max_retry_duration   = "3600s"
    min_backoff_duration = "30s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.signals_collector.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.signals_collector,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}
