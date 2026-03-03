/**
 * ASX Announcement Crawler Module
 *
 * Manages:
 * - Cloud Run Job for crawling ASX announcements
 * - Extracts director trades, dividends, and news articles
 * - Service account and IAM permissions
 * - Cloud Scheduler job (daily)
 */

locals {
  service_name = "asx-announcement-crawler"
  labels = {
    service     = "asx-announcement-crawler"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run job
resource "google_service_account" "asx_announcement_crawler" {
  account_id   = local.service_name
  display_name = "ASX Announcement Crawler"
  description  = "Service account for crawling ASX announcements"
  project      = var.project_id
}

# Grant Secret Manager access for DATABASE_URL
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.asx_announcement_crawler.email}"
  project   = var.project_id
}

# Grant Secret Manager access for OpenTelemetry OTLP headers
resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.asx_announcement_crawler.email}"
  project   = var.project_id
}

# Cloud Run Job (v2)
resource "google_cloud_run_v2_job" "asx_announcement_crawler" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.asx_announcement_crawler.email

      max_retries = 2
      timeout     = "3600s" # 1 hour - crawling many stocks takes time

      containers {
        image = var.image_url

        # Enable director trades, dividends, and news extraction
        args = ["-director-trades", "-dividends", "-news-table", "-years", "2024,2025,2026"]

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
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.otel_headers,
  ]
}

# Service account for Cloud Scheduler to invoke the job
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-sched"
  display_name = "ASX Announcement Crawler Scheduler"
  description  = "Service account for Cloud Scheduler to invoke ASX announcement crawler"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.asx_announcement_crawler.name
  location = google_cloud_run_v2_job.asx_announcement_crawler.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job - Daily at 9 PM AEST (11 AM UTC)
resource "google_cloud_scheduler_job" "asx_announcement_crawler" {
  name             = "${local.service_name}-daily"
  description      = "Daily crawl of ASX announcements for director trades, dividends, and news"
  schedule         = "0 11 * * *" # 11 AM UTC = 9 PM AEST
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
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.asx_announcement_crawler.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.asx_announcement_crawler,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}
