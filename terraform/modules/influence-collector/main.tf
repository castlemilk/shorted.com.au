/**
 * Influence Collector Module
 *
 * Cloud Run Job + Cloud Scheduler that runs services/influence-collector over
 * Australia's public "influence layer": ATO corporate tax transparency, CER NGER
 * emissions, AusTender contracts, AEC transparency-register returns, the
 * lobbyist and FITS registers, and ABS trade in goods.
 *
 * Monthly, an hour after economy-collector (17:00 UTC) and two after
 * house-price-collector (16:00 UTC), so the three ingest jobs never stampede the
 * database together.
 *
 * THE APH REGISTER-OF-INTERESTS MODES ARE DELIBERATELY NOT SCHEDULED.
 * `-mode all` excludes register-discover/fetch/load/resolve by design: a
 * 804-document crawl of aph.gov.au must never fire from a deploy step or a
 * monthly timer that nobody is watching. They are operator-run
 * (`gcloud run jobs execute --args=...`), they dry-run unless
 * REGISTER_DRY_RUN=false, and register-fetch aborts the whole run on a single
 * 403 rather than hammering through a WAF policy change.
 */

locals {
  service_name = "influence-collector"
  labels = {
    service     = "influence-collector"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "collector" {
  account_id   = local.service_name
  display_name = "Influence Collector Job"
  description  = "Service account for the ATO/CER/AusTender/AEC/APH influence collector"
  project      = var.project_id
}

# Read DATABASE_URL from Secret Manager.
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collector.email}"
  project   = var.project_id
}

# ---------------------------------------------------------------------------
# Private store for fetched register PDFs.
#
# The licence permits extracted facts with attribution, NOT a mirror. So the
# bucket is private by construction and short-lived: uniform bucket-level access,
# public_access_prevention enforced, no allUsers binding ever, and a lifecycle
# rule that deletes objects after var.register_retention_days. The retention is
# what makes "we do not maintain a mirror" true in fact rather than in intent.
#
# Owned by THIS module even though report-extractor reads from it. Binding IAM
# on another module's bucket is what produced the cross-project getIamPolicy 403
# documented in the report-extractor module's `removed {}` block — grant readers
# here instead, via var.reader_service_accounts.
# ---------------------------------------------------------------------------
resource "google_storage_bucket" "register" {
  count = var.manage_register_bucket ? 1 : 0

  name     = var.register_bucket_name != "" ? var.register_bucket_name : "${var.project_id}-register-interests"
  location = var.region
  project  = var.project_id
  labels   = local.labels

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  lifecycle_rule {
    condition {
      age = var.register_retention_days
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "collector_writer" {
  count = var.manage_register_bucket ? 1 : 0

  bucket = google_storage_bucket.register[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.collector.email}"
}

# The extractor reads the PDFs it must parse. objectViewer, never admin.
resource "google_storage_bucket_iam_member" "readers" {
  for_each = var.manage_register_bucket ? toset(var.reader_service_accounts) : toset([])

  bucket = google_storage_bucket.register[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${each.value}"
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

      # The binary self-cancels at 15 minutes (main.go: context.WithTimeout).
      # 1200s leaves 5 minutes of container start/shutdown headroom. A larger
      # value would be decorative and would imply runs can last longer than they
      # can.
      timeout = "1200s"

      containers {
        image = var.image_url

        # EXPLICIT, not inherited. This binary's flag default is `-mode tax`,
        # unlike economy-collector and house-price-collector which default to
        # `all`. A job created without args would silently ingest ATO corporate
        # tax only and report success.
        args = ["-mode", "all"]

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

        # Register crawl configuration. Inert for `-mode all` (which excludes the
        # register modes), and present so an operator-run register job needs no
        # ad-hoc env.
        dynamic "env" {
          for_each = var.manage_register_bucket ? [1] : []
          content {
            name  = "REGISTER_BUCKET"
            value = google_storage_bucket.register[0].name
          }
        }
        env {
          name  = "REGISTER_BUCKET_PREFIX"
          value = var.register_bucket_prefix
        }

        # Defaults TRUE in code. Pinned here so the value is visible in the job
        # definition rather than implied: a crawl of a parliamentary website is
        # never something to start by accident.
        env {
          name  = "REGISTER_DRY_RUN"
          value = "true"
        }
        env {
          name  = "REGISTER_FETCH_DELAY_MS"
          value = tostring(var.register_fetch_delay_ms)
        }

        resources {
          limits = {
            cpu = "1"
            # 1Gi, not economy-collector's 512Mi: this job streams multi-MB ATO
            # and AusTender archives and parses XLSX in memory.
            memory = "1Gi"
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
  display_name = "Influence Collector Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the influence collector"
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
  description      = "Monthly ATO/CER/AusTender/AEC/lobbyist/trade influence ingest (NOT the APH register crawl)"
  schedule         = "0 18 5 * *" # 5th of month, 18:00 UTC — an hour after economy-collector
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id

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
