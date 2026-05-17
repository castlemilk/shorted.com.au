/**
 * News Aggregator Module
 *
 * Manages:
 * - Cloud Run Job for aggregating news from RSS feeds
 * - Service account and IAM permissions
 * - Cloud Scheduler job (every 4 hours)
 */

locals {
  service_name = "news-aggregator"
  labels = {
    service     = "news-aggregator"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service Account for the Cloud Run job
resource "google_service_account" "news_aggregator" {
  account_id   = local.service_name
  display_name = "News Aggregator"
  description  = "Service account for aggregating news from RSS feeds"
  project      = var.project_id
}

# Grant Secret Manager access for DATABASE_URL
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.news_aggregator.email}"
  project   = var.project_id
}

# Grant Secret Manager access for OpenTelemetry OTLP headers
resource "google_secret_manager_secret_iam_member" "otel_headers" {
  secret_id = "OTEL_EXPORTER_OTLP_HEADERS"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.news_aggregator.email}"
  project   = var.project_id
}

# Grant Secret Manager access for GEMINI_API_KEY (AI-powered sentiment analysis)
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  count     = var.gemini_secret_exists ? 1 : 0
  secret_id = "GEMINI_API_KEY"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.news_aggregator.email}"
  project   = var.project_id
}

# Cloud Run Job (v2)
resource "google_cloud_run_v2_job" "news_aggregator" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.news_aggregator.email

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

        # Gemini API key for AI-powered sentiment analysis
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
            memory = "512Mi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.otel_headers,
    google_secret_manager_secret_iam_member.gemini_api_key,
  ]
}

# Service account for Cloud Scheduler to invoke the job
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-scheduler"
  display_name = "News Aggregator Scheduler"
  description  = "Service account for Cloud Scheduler to invoke news aggregator job"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.news_aggregator.name
  location = google_cloud_run_v2_job.news_aggregator.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# run.developer is required for runWithOverrides — the backfill scheduler
# passes container_overrides to set RUN_MODE=backfill-images on the
# existing news-aggregator job binary.
resource "google_cloud_run_v2_job_iam_member" "scheduler_developer" {
  name     = google_cloud_run_v2_job.news_aggregator.name
  location = google_cloud_run_v2_job.news_aggregator.location
  project  = var.project_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job - Every 4 hours
resource "google_cloud_scheduler_job" "news_aggregator" {
  name             = "${local.service_name}-periodic"
  description      = "Aggregate news from RSS feeds every 4 hours"
  schedule         = "0 */4 * * *" # Every 4 hours
  time_zone        = "UTC"
  attempt_deadline = "600s"
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 2
    max_retry_duration   = "1800s"
    min_backoff_duration = "10s"
    max_backoff_duration = "600s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.news_aggregator.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.news_aggregator,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}

# Cloud Scheduler Job — OG-image backfill, daily at 03:00 UTC (~1 PM AEST).
# Runs the same news-aggregator binary with RUN_MODE=backfill-images via
# container_overrides, scraping og:image meta tags from articles still
# missing image_url. Skips asx (PDF announcements) and googlenews
# (Google redirects) — handled in the Go code's default SkipSources.
resource "google_cloud_scheduler_job" "news_aggregator_backfill_images" {
  name             = "${local.service_name}-backfill-images"
  description      = "Daily og:image backfill for news_articles rows missing image_url"
  schedule         = "0 3 * * *"
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
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.news_aggregator.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }

    body = base64encode(jsonencode({
      overrides = {
        container_overrides = [{
          env = [
            { name = "RUN_MODE", value = "backfill-images" },
            { name = "BACKFILL_LIMIT", value = "2000" },
            { name = "BACKFILL_CONCURRENCY", value = "6" },
          ]
        }]
      }
    }))
  }

  depends_on = [
    google_cloud_run_v2_job.news_aggregator,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_cloud_run_v2_job_iam_member.scheduler_developer,
  ]
}
