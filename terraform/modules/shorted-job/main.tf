/**
 * Shorted Job Module (generic)
 *
 * ONE reusable Cloud Run Job + Cloud Scheduler + invoker service account for
 * the consolidated `shorted <subcommand> [flags]` binary (services/jobs).
 *
 * Replaces the copy-pasted per-job modules one migration at a time: each
 * instantiation is the same image with different `args`, resources and cron.
 * Resource shapes are lifted verbatim from modules/economy-collector +
 * modules/asx-announcement-crawler — no new patterns.
 *
 * Cost guardrail: Cloud Run Jobs have no min-instance concept, so there is
 * nothing to pin to zero here; keep cpu/memory at the migrated job's sizing.
 */

locals {
  labels = {
    service     = var.name
    environment = var.environment
    managed_by  = "terraform"
  }
}

# Service account the job runs as.
resource "google_service_account" "job" {
  account_id   = var.name
  display_name = "Shorted job: ${var.name}"
  description  = "Service account for the consolidated shorted job '${join(" ", var.args)}'"
  project      = var.project_id
}

# Secret Manager access for every secret-backed env var.
resource "google_secret_manager_secret_iam_member" "secrets" {
  for_each = toset(values(var.secret_env))

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
  project   = var.project_id
}

resource "google_cloud_run_v2_job" "job" {
  name     = var.name
  location = var.region
  project  = var.project_id
  labels   = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.job.email
      max_retries     = var.max_retries
      timeout         = "${var.timeout_seconds}s"

      containers {
        image = var.image_url
        args  = var.args

        dynamic "env" {
          for_each = var.env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = var.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.secrets]
}

# Service account for Cloud Scheduler to invoke the job.
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${var.name}-sched"
  display_name = "Shorted job scheduler: ${var.name}"
  description  = "Service account for Cloud Scheduler to invoke the ${var.name} job"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.job.name
  location = google_cloud_run_v2_job.job.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "schedule" {
  name             = "${var.name}-schedule"
  description      = var.description != "" ? var.description : "Scheduled run of `shorted ${join(" ", var.args)}`"
  schedule         = var.schedule
  time_zone        = "UTC"
  attempt_deadline = var.scheduler_attempt_deadline
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.paused

  retry_config {
    retry_count          = 2
    max_retry_duration   = "3600s"
    min_backoff_duration = "10s"
    max_backoff_duration = "1800s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.job.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.job,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}
