/**
 * Report Extractor Module
 *
 * Manages TWO Cloud Run Jobs from ONE image (services/report-extractor):
 *   - director-trade-extractor    (extract_director_trades.py): Appendix 3Y PDFs -> director_trades
 *   - financial-report-extractor  (extract_reports_concurrent.py): report PDFs -> financial_report_extractions + digests
 * Plus a shared service account, secret IAM (DATABASE_URL, OTEL, optional GEMINI_API_KEY),
 * GCS write access for digest raw-text, and a Cloud Scheduler per job.
 *
 * Both scripts need a Gemini key (gemini-2.5-flash). In environments where the GEMINI_API_KEY
 * secret does not yet exist (prod), set gemini_secret_exists=false — the jobs deploy but will
 * exit early until the key is provisioned. Both are incremental/idempotent (skip already-
 * extracted rows), so re-runs converge.
 */

locals {
  labels = {
    service     = "report-extractor"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "report_extractor" {
  account_id   = "report-extractor"
  display_name = "Report Extractor"
  description  = "Service account for the financial-report + director-trade extractors"
  project      = var.project_id
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.report_extractor.email}"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.report_extractor.email}"
  project   = var.project_id
}

# Optional — only when the GEMINI_API_KEY secret exists in this project.
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  count     = var.gemini_secret_exists ? 1 : 0
  secret_id = var.gemini_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.report_extractor.email}"
  project   = var.project_id
}

# Preserve the prior state-only removal so Terraform never tries to destroy the
# historical cross-project binding while completing the production cutover.
removed {
  from = google_storage_bucket_iam_member.reports_bucket
  lifecycle {
    destroy = false
  }
}

# ---------------------------------------------------------------------------
# Job 1: director-trade-extractor  (extract_director_trades.py)
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "director_trade_extractor" {
  name     = "director-trade-extractor"
  location = var.region
  project  = var.project_id
  labels   = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.report_extractor.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        image   = var.image_url
        command = ["python", "extract_director_trades.py"]
        args    = ["--priority", "recent", "--limit", tostring(var.director_limit), "--workers", "2"]

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
        dynamic "env" {
          for_each = var.gemini_secret_exists ? [1] : []
          content {
            name = "GEMINI_API_KEY"
            value_source {
              secret_key_ref {
                secret  = var.gemini_secret_name
                version = "latest"
              }
            }
          }
        }
        env {
          name  = "GEMINI_MAX_RUN_ITEMS"
          value = tostring(var.director_limit)
        }
        env {
          name  = "GEMINI_MAX_RUN_WORKERS"
          value = "2"
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
            memory = "1Gi"
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

# ---------------------------------------------------------------------------
# Job 2: financial-report-extractor  (extract_reports_concurrent.py)
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "financial_report_extractor" {
  name     = "financial-report-extractor"
  location = var.region
  project  = var.project_id
  labels   = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.report_extractor.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        image   = var.image_url
        command = ["python", "extract_reports_concurrent.py"]
        args    = ["--recent", "2", "--limit", tostring(var.reports_limit), "--workers", "2", "--max-pages", "6", "--top-shorted-first"]

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
        dynamic "env" {
          for_each = var.gemini_secret_exists ? [1] : []
          content {
            name = "GEMINI_API_KEY"
            value_source {
              secret_key_ref {
                secret  = var.gemini_secret_name
                version = "latest"
              }
            }
          }
        }
        # langextract reads its key from LANGEXTRACT_API_KEY; mirror the Gemini key.
        dynamic "env" {
          for_each = var.gemini_secret_exists ? [1] : []
          content {
            name = "LANGEXTRACT_API_KEY"
            value_source {
              secret_key_ref {
                secret  = var.gemini_secret_name
                version = "latest"
              }
            }
          }
        }
        env {
          name  = "GEMINI_MAX_RUN_ITEMS"
          value = tostring(var.reports_limit)
        }
        env {
          name  = "GEMINI_MAX_RUN_WORKERS"
          value = "2"
        }
        env {
          name  = "GCS_REPORTS_BUCKET"
          value = var.reports_bucket
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
            memory = "1Gi"
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

# ---------------------------------------------------------------------------
# Scheduling — shared invoker SA, one scheduler per job.
# ---------------------------------------------------------------------------
resource "google_service_account" "scheduler_invoker" {
  account_id   = "report-extractor-sched"
  display_name = "Report Extractor Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the report-extractor jobs"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "director_invoker" {
  name     = google_cloud_run_v2_job.director_trade_extractor.name
  location = google_cloud_run_v2_job.director_trade_extractor.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_run_v2_job_iam_member" "reports_invoker" {
  name     = google_cloud_run_v2_job.financial_report_extractor.name
  location = google_cloud_run_v2_job.financial_report_extractor.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Director extractor — daily, chained after the asx-announcement-crawler (which runs
# 11:00 UTC) populates new Appendix 3Y URLs. Runs 12:30 UTC.
resource "google_cloud_scheduler_job" "director_trade_extractor" {
  name             = "director-trade-extractor-daily"
  description      = "Daily extraction of director trades from Appendix 3Y PDFs"
  schedule         = var.director_schedule
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 0
    min_backoff_duration = "30s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.director_trade_extractor.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.director_invoker]
}

# Financial-report extractor — weekly (Sundays 14:00 UTC).
resource "google_cloud_scheduler_job" "financial_report_extractor" {
  name             = "financial-report-extractor-weekly"
  description      = "Weekly financial-report digest extraction (top-shorted first)"
  schedule         = var.reports_schedule
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 0
    min_backoff_duration = "30s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.financial_report_extractor.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.reports_invoker]
}
