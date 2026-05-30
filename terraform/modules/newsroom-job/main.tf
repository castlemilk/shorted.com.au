/**
 * Newsroom Job Module
 *
 * Manages:
 * - Cloud Run Job for daily take-writer newsroom generation
 * - Service account and IAM permissions (Secret Manager + GCS)
 * - Cloud Scheduler job (daily, 06:00 AEST = 20:00 UTC)
 */

locals {
  service_name = "newsroom-daily"
  labels = {
    service     = "newsroom-daily"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run job
resource "google_service_account" "newsroom" {
  account_id   = "newsroom-job"
  display_name = "Newsroom Daily Job"
  description  = "Service account for the daily take-writer newsroom Cloud Run job"
  project      = var.project_id
}

# Grant Secret Manager access for DATABASE_URL
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
  project   = var.project_id
}

# Grant Secret Manager access for OPENAI_API_KEY
resource "google_secret_manager_secret_iam_member" "openai_api_key" {
  secret_id = "OPENAI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
  project   = var.project_id
}

# Grant Secret Manager access for GEMINI_API_KEY (optional — created only if secret exists)
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  count     = var.gemini_secret_exists ? 1 : 0
  secret_id = "GEMINI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
  project   = var.project_id
}

# Grant Secret Manager access for ANTHROPIC_API_KEY (optional — created only if secret exists)
resource "google_secret_manager_secret_iam_member" "anthropic_api_key" {
  count     = var.anthropic_secret_exists ? 1 : 0
  secret_id = "ANTHROPIC_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
  project   = var.project_id
}

# Grant access to OpenTelemetry OTLP headers secret
resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
  project   = var.project_id
}

# Grant GCS object read/write access for company logos
resource "google_storage_bucket_iam_member" "newsroom_gcs" {
  bucket = var.gcs_logo_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.newsroom.email}"
}

# Cloud Run Job (v2)
resource "google_cloud_run_v2_job" "newsroom" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.newsroom.email

      max_retries = 0
      timeout     = "1800s" # 30 minutes

      containers {
        image = var.image_url
        args  = ["newsroom-daily", "--auto-publish", "--with-images"]

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GCS_LOGO_BUCKET"
          value = var.gcs_logo_bucket
        }

        env {
          name  = "MAX_TAKES_PER_DAY"
          value = var.max_takes_per_day
        }

        env {
          name  = "MAX_DEEPDIVES_PER_DAY"
          value = var.max_deepdives_per_day
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
          name = "OPENAI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = "OPENAI_API_KEY"
              version = "latest"
            }
          }
        }

        dynamic "env" {
          for_each = var.gemini_secret_exists ? [1] : []
          content {
            name = "GEMINI_API_KEY"
            value_source {
              secret_key_ref {
                secret  = "GEMINI_API_KEY"
                version = "latest"
              }
            }
          }
        }

        dynamic "env" {
          for_each = var.anthropic_secret_exists ? [1] : []
          content {
            name = "ANTHROPIC_API_KEY"
            value_source {
              secret_key_ref {
                secret  = "ANTHROPIC_API_KEY"
                version = "latest"
              }
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
            cpu    = "2"
            memory = "2Gi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.openai_api_key,
    google_secret_manager_secret_iam_member.otel_headers,
  ]
}

# Service account for Cloud Scheduler to invoke the job
resource "google_service_account" "scheduler_invoker" {
  account_id   = "newsroom-scheduler"
  display_name = "Newsroom Daily Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the newsroom daily job"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.newsroom.name
  location = google_cloud_run_v2_job.newsroom.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job — daily at 06:00 AEST (20:00 UTC previous day)
resource "google_cloud_scheduler_job" "newsroom_daily" {
  name             = "${local.service_name}-trigger"
  description      = "Daily trigger for the take-writer newsroom job (06:00 AEST)"
  schedule         = var.schedule
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 1
    max_retry_duration   = "3600s"
    min_backoff_duration = "30s"
    max_backoff_duration = "600s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.newsroom.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.newsroom,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
  ]
}
