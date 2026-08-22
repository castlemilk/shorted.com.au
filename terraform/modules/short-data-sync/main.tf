/**
 * Short Data Sync Module
 *
 * Manages:
 * - Cloud Run Job for syncing ASIC short selling data
 * - Service account and IAM permissions
 * - Cloud Scheduler job (daily trigger)
 * - GCS bucket for storing CSV files
 *
 * # Jobs-monolith: this job is MONOLITH-ONLY
 *
 * The `shorts-data-sync` Cloud Run Job runs the consolidated Go binary
 * (`shorted short-data-sync`, services/jobs). Nothing about the deployment
 * IDENTITY ever changed at cutover: same job name (`shorts-data-sync`), same
 * service accounts, same scheduler (`shorts-data-sync-daily`, 0 10 * * * UTC),
 * same GCS bucket, same secrets — only image + command/args + task sizing were
 * swapped IN PLACE, so the job is updated, never replaced.
 *
 * HISTORICAL: before the cutover this job ran a PYTHON image built from
 * services/daily-sync/Dockerfile (CMD ["python","comprehensive_daily_sync.py"]).
 * The cutover (shadow parity 6/6 + a green scheduled run 2026-08-21) satisfied
 * the deletion gate, so the cleanup slice removed services/daily-sync,
 * services/short-data-sync, the `use_go_monolith` toggle, the `image_url`
 * legacy input and the `short-data-sync` CI image build.
 *
 * ## Rollback
 *
 * There is no longer a one-variable flip: the Python source is gone and CI no
 * longer refreshes the `short-data-sync` image tag. Rollback is
 * `git revert` of the cleanup commit (which restores the toggle, the legacy
 * variables and the CI matrix entry) followed by a `terraform apply`. The last
 * legacy image remains in Artifact Registry, so nothing needs rebuilding
 * first — but its tag is frozen at the pre-cleanup build.
 *
 * Image, command, args, timeout and retries stay written together in the
 * locals below for the same reason they were coupled before: an image-only
 * change that left `/shorted` in place would crash-loop with
 * `exec: "/shorted": not found` — the rollback would BE the outage.
 */

locals {
  service_name = "shorts-data-sync" # Match existing job name
  labels = {
    service     = "short-data-sync"
    environment = var.environment
    managed_by  = "terraform"
  }

  job_image   = var.shorted_jobs_image
  job_command = ["/shorted"]
  job_args    = ["short-data-sync"]

  # Sizing follows from what the job actually does: shorts-only. No
  # yfinance/Alpha-Vantage price sweep, so no 500-stock batching, no
  # checkpointing, no exit-2 "partial" retry protocol — the run either
  # completes or fails. The ASIC ingest takes minutes and the MV refresh a few
  # more, so 3600s is ~10x headroom and 1 retry covers a transient pooler blip.
  # (The Python runs took 26-29h WITH retries at 8h x 6 attempts; that sizing
  # delayed paging on a real failure by the better part of two days.)
  job_timeout_seconds = 3600
  job_max_retries     = 1
}

# GCS Bucket for short selling data
resource "google_storage_bucket" "short_selling_data" {
  name          = var.bucket_name != "" ? var.bucket_name : "shorted-short-selling-data"
  location      = "US" # Multi-region for better availability
  project       = var.project_id
  force_destroy = false

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Don't add labels/autoclass to match existing bucket (avoids replacement)

  lifecycle_rule {
    condition {
      age = 365 # Keep data for 1 year
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    ignore_changes = [
      labels,
      autoclass, # Ignore autoclass if it was enabled manually
      soft_delete_policy
    ]
  }
}

# Service Account for the Cloud Run job
resource "google_service_account" "short_data_sync" {
  account_id   = local.service_name
  display_name = "Short Data Sync Job"
  description  = "Service account for syncing ASIC short selling data"
  project      = var.project_id
}

# Grant GCS access to service account
resource "google_storage_bucket_iam_member" "short_data_sync_bucket" {
  bucket = google_storage_bucket.short_selling_data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.short_data_sync.email}"
}

# Readers of this bucket — in practice the shorts API, which serves
# GET /api/admin/jobs/validate-sync by reading the per-stock validation report
# this job publishes at validations/<execution>.json.
#
# objectViewer, never admin: the API only ever reads.
#
# Granted HERE, from the module that OWNS the bucket, for two reasons. It is
# the convention the influence-collector module already sets (binding IAM on a
# bucket owned by another module is what produced the getIamPolicy 403 in
# report-extractor's `removed {}` block), and it keeps the dependency in one
# direction — this module takes the API's service account, and the API takes
# only a bucket NAME (from a local in environments/*/main.tf), so the two
# modules never depend on each other's outputs.
#
# This binding is also the whole reason the feature is deployable: BUCKET IAM
# is writable by the CI deploy service account, PROJECT IAM is not. The first
# cut of the validation endpoint read Cloud Logging instead and needed a
# project-level roles/logging.viewer, which 403'd on every apply. See the
# comment where that resource used to live, in modules/shorts-api/main.tf.
resource "google_storage_bucket_iam_member" "readers" {
  for_each = toset(var.reader_service_accounts)

  bucket = google_storage_bucket.short_selling_data.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${each.value}"
}

# Grant Secret Manager access to service account
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.short_data_sync.email}"
  project   = var.project_id
}

# Grant access to the revalidation secret (event-driven cache invalidation).
# Guarded: only when the secret actually exists (see manage_revalidation_secret).
resource "google_secret_manager_secret_iam_member" "revalidation_secret" {
  count     = var.manage_revalidation_secret ? 1 : 0
  secret_id = "REVALIDATION_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.short_data_sync.email}"
  project   = var.project_id
}

# Cloud Run Job (v2)
resource "google_cloud_run_v2_job" "short_data_sync" {
  name     = local.service_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.short_data_sync.email

      # Right-sized for the shorts-only Go run — see the locals block.
      max_retries = local.job_max_retries
      timeout     = "${local.job_timeout_seconds}s"

      containers {
        # The shorted-jobs image (ENTRYPOINT /shorted); command is set
        # explicitly so the args are unambiguous.
        image   = local.job_image
        command = local.job_command
        args    = local.job_args

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }

        # Where a VALIDATION run (`-shadow -stocks BHP,DRO`) publishes its
        # report: gs://<this bucket>/validations/<CLOUD_RUN_EXECUTION>.json.
        # The shorts API reads exactly that key (same variable name there).
        #
        # A plain `-shadow` parity run writes NOTHING to this bucket regardless
        # of this variable — the artifact is gated on -stocks in the job itself
        # (services/jobs/internal/jobs/shortdatasync/artifact.go).
        env {
          name  = "SHORTS_DATA_BUCKET"
          value = google_storage_bucket.short_selling_data.name
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

        # Look-back window used only when the shorts table is empty. Set
        # EXPLICITLY because the distroless monolith image carries no ENV at
        # all (the retired Python image supplied its own
        # `ENV SYNC_DAYS_SHORTS=7`). 7 is also the Go job's compiled default.
        env {
          name  = "SYNC_DAYS_SHORTS"
          value = tostring(var.sync_days_shorts)
        }

        # NOT set: SYNC_ALGOLIA (and therefore ALGOLIA_APP_ID /
        # ALGOLIA_ADMIN_KEY / ALGOLIA_SYNC_URL / ALGOLIA_SYNC_TOKEN). The Go
        # job gates its Algolia trigger on GetEnvBool("SYNC_ALGOLIA", false),
        # which is OFF here; Algolia is reindexed out of band.
        #
        # Also NOT set: SYNC_DAYS_STOCK_PRICES, SYNC_KEY_METRICS,
        # ALPHA_VANTAGE_API_KEY, MAX_STOCK_FAILURE_RETRIES. The Go job does not
        # sync prices or key metrics (`shorted market-data` owns stock_prices;
        # the shorts API's key-metrics-scheduler owns key_metrics) and warns
        # loudly if any of them IS set.

        # Event-driven cache revalidation: after writing new ASIC data, ping the
        # frontend to bust the cached SSR pages (fires only when data changed).
        env {
          name  = "REVALIDATION_URL"
          value = var.revalidation_url
        }

        # Mounted only when the secret exists; otherwise revalidation is
        # skipped gracefully — platform.PingRevalidate no-ops on an unset
        # REVALIDATION_URL/REVALIDATION_SECRET and never fails the run (see
        # manage_revalidation_secret).
        dynamic "env" {
          for_each = var.manage_revalidation_secret ? [1] : []
          content {
            name = "REVALIDATION_SECRET"
            value_source {
              secret_key_ref {
                secret  = "REVALIDATION_SECRET"
                version = "latest"
              }
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

  lifecycle {
    # An unset image would silently deploy an empty image reference; fail at
    # PLAN time instead. Kept as a precondition rather than a variable
    # `validation` so the error names the resource being built.
    precondition {
      condition     = var.shorted_jobs_image != ""
      error_message = "shorted_jobs_image is required (the consolidated `shorted` binary image). This job is monolith-only; CI passes -var=shorted_jobs_image= on plan and apply."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.revalidation_secret,
    google_storage_bucket_iam_member.short_data_sync_bucket
  ]
}

# Service account for Cloud Scheduler to invoke the job
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-scheduler"
  display_name = "Short Data Sync Scheduler"
  description  = "Service account for Cloud Scheduler to invoke short data sync job"
  project      = var.project_id
}

# Grant Cloud Run Invoker role to scheduler service account
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_job.short_data_sync.name
  location = google_cloud_run_v2_job.short_data_sync.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job - Daily Sync
resource "google_cloud_scheduler_job" "daily_sync" {
  name             = "${local.service_name}-daily"
  description      = "Daily sync of ASIC short selling data"
  schedule         = "0 10 * * *" # 8 PM AEST (10 AM UTC)
  time_zone        = "UTC"
  attempt_deadline = "1800s" # 30 minutes (max allowed by Cloud Scheduler)
  region           = var.scheduler_region
  project          = var.project_id

  retry_config {
    retry_count          = 2
    max_retry_duration   = "7200s"
    min_backoff_duration = "10s"
    max_backoff_duration = "3600s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.short_data_sync.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.short_data_sync,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}

