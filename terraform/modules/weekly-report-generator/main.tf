/**
 * Weekly Report Generator Module
 *
 * Manages:
 * - Cloud Run Job for generating weekly short selling reports (LLM narrative)
 * - Service account and IAM permissions
 * - Cloud Scheduler job (Friday evening AEST trigger)
 */

locals {
  service_name = "weekly-report-generator"
  labels = {
    service     = "weekly-report-generator"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run job
resource "google_service_account" "weekly_report_generator" {
  account_id   = local.service_name
  display_name = "Weekly Report Generator Job"
  description  = "Service account for generating weekly short selling reports"
  project      = var.project_id
}

# Grant Secret Manager access for DATABASE_URL
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weekly_report_generator.email}"
  project   = var.project_id
}

# Grant Secret Manager access for OPENAI_API_KEY
resource "google_secret_manager_secret_iam_member" "openai_api_key" {
  secret_id = "OPENAI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weekly_report_generator.email}"
  project   = var.project_id
}

# Grant access to OpenTelemetry OTLP headers secret
resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weekly_report_generator.email}"
  project   = var.project_id
}

# Grant Secret Manager access for GEMINI_API_KEY (optional — created only if secret exists)
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  count     = var.gemini_secret_exists ? 1 : 0
  secret_id = "GEMINI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weekly_report_generator.email}"
  project   = var.project_id
}

# Cloud Run Job (v2)
resource "google_cloud_run_v2_job" "weekly_report_generator" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.weekly_report_generator.email

      max_retries = 2
      timeout     = "900s" # 15 minutes

      containers {
        image = var.image_url

        env {
          name  = "ENVIRONMENT"
          value = var.environment
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
  account_id   = "${local.service_name}-sched"
  display_name = "Weekly Report Generator Scheduler"
  description  = "Service account for Cloud Scheduler to invoke weekly report generator"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.weekly_report_generator.name
  location = google_cloud_run_v2_job.weekly_report_generator.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job - Friday 9 PM AEST (11 AM UTC)
resource "google_cloud_scheduler_job" "weekly_report" {
  name             = "${local.service_name}-weekly"
  description      = "Weekly generation of short selling report with LLM narrative"
  schedule         = "0 11 * * 5" # Friday 11 AM UTC = 9 PM AEST
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 2
    max_retry_duration   = "3600s"
    min_backoff_duration = "10s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.weekly_report_generator.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.weekly_report_generator,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}
