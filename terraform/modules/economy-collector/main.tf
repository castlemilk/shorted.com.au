/**
 * Economy Collector Module
 *
 * Cloud Run Job + Cloud Scheduler that runs services/economy-collector in
 * its default mode (ABS/RBA/DCCEEW ingest).
 * Monthly cadence, scheduled an hour after the house-price collector so the
 * two jobs don't stampede the database at the same time.
 */

locals {
  service_name = "economy-collector"
  labels = {
    service     = "economy-collector"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "collector" {
  account_id   = local.service_name
  display_name = "Economy Collector Job"
  description  = "Service account for the ABS/RBA/DCCEEW economy collector"
  project      = var.project_id
}

# Read DATABASE_URL from Secret Manager.
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collector.email}"
  project   = var.project_id
}

resource "google_cloud_run_v2_job" "collector" {
  name     = local.service_name
  location = var.region
  project  = var.project_id
  labels   = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.collector.email
      max_retries     = 2
      timeout         = "1800s" # 30 min — the official ingest is small and fast

      containers {
        image = var.image_url
        # Default ENTRYPOINT runs -mode all (all six official-source ingests).

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

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.database_url]
}

# Service account for Cloud Scheduler to invoke the job.
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-sched"
  display_name = "Economy Collector Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the economy collector"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.collector.name
  location = google_cloud_run_v2_job.collector.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "monthly" {
  name             = "${local.service_name}-monthly"
  description      = "Monthly ABS/RBA/DCCEEW economy ingest"
  schedule         = "0 17 5 * *" # 5th of month, 17:00 UTC (an hour after the housing job)
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.scheduler_paused

  retry_config {
    retry_count          = 2
    max_retry_duration   = "3600s"
    min_backoff_duration = "10s"
    max_backoff_duration = "600s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.collector.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.collector,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}
