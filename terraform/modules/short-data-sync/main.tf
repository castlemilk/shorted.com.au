/**
 * Short Data Sync Module
 *
 * Manages:
 * - Cloud Run Job for syncing ASIC short selling data
 * - Service account and IAM permissions
 * - Cloud Scheduler job (daily trigger)
 * - GCS bucket for storing CSV files
 *
 * # Jobs-monolith cutover (Phase 3, item 9)
 *
 * The `shorts-data-sync` Cloud Run Job runs the consolidated Go binary
 * (`shorted short-data-sync`, services/jobs) as of the cutover PR. Nothing
 * about the deployment IDENTITY changed: same job name (`shorts-data-sync`),
 * same service accounts, same scheduler (`shorts-data-sync-daily`, 0 10 * * *
 * UTC), same GCS bucket, same secrets. Only the container image + command/args
 * + task sizing are swapped IN PLACE, so the job is updated, never replaced.
 *
 * HISTORICAL: before the cutover this job ran the PYTHON image built from
 * services/daily-sync/Dockerfile (CMD ["python","comprehensive_daily_sync.py"])
 * — NOT services/short-data-sync/, which was a never-deployed sibling. That
 * image is still built by CI and still reachable via the rollback below; the
 * legacy path is a supported mode of this module, not dead code.
 *
 * ## Rollback (one variable)
 *
 *   use_go_monolith = false
 *
 * at the call site, then apply. That restores the Python image AND its command
 * (the image's own ENTRYPOINT/CMD) AND its 28800s/5-retry sizing in one move.
 * Image and command/args/timeout/retries are COUPLED in the locals below on
 * purpose: an image-only rollback that left `/shorted` in place would
 * crash-loop with `exec: "/shorted": not found` — the rollback would BE the
 * outage (the trap caught in review on the market-data-sync cutover).
 *
 * ## Deletion gate (plan invariant)
 *
 * services/daily-sync and services/short-data-sync stay in the repo, and the
 * `short-data-sync` image stays in the CI build matrix, until the monolith has
 * had ONE GREEN SCHEDULED run (not a manual execution). Pause, don't delete:
 * a rollback needs a currently-built image.
 */

locals {
  service_name = "shorts-data-sync" # Match existing job name
  labels = {
    service     = "short-data-sync"
    environment = var.environment
    managed_by  = "terraform"
  }

  # ---------------------------------------------------------------------------
  # The cutover coupling. ONE toggle drives image + command + args + sizing;
  # these four must never be settable independently (see the header comment).
  # ---------------------------------------------------------------------------

  # `null` (not `[]`) in legacy mode so the attributes are OMITTED and the
  # Python image's own ENTRYPOINT/CMD applies — an empty list would CLEAR it.
  job_image   = var.use_go_monolith ? var.shorted_jobs_image : var.image_url
  job_command = var.use_go_monolith ? ["/shorted"] : null
  job_args    = var.use_go_monolith ? ["short-data-sync"] : null

  # Sizing is part of the same decision:
  #
  #  - MONOLITH: shorts-only. No yfinance/Alpha-Vantage price sweep, so no
  #    500-stock batching, no checkpointing, no exit-2 "partial" retry
  #    protocol — the run either completes or fails. The ASIC ingest takes
  #    minutes and the MV refresh a few more, so 3600s is ~10x headroom and 1
  #    retry covers a transient pooler blip. (Python runs took 26-29h WITH
  #    retries; keeping 8h/5 here would just delay paging on a real failure by
  #    the better part of two days.)
  #  - LEGACY: the historical 8h x 6 attempts sized for that price sweep.
  job_timeout_seconds = var.use_go_monolith ? 3600 : 28800
  job_max_retries     = var.use_go_monolith ? 1 : 5
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

      # Both coupled to var.use_go_monolith — see the locals block.
      #
      # LEGACY (Python) sizing, kept exactly as it was for rollback: the script
      # processed SYNC_BATCH_SIZE (500) stocks per attempt (~5h each) and exited 2
      # to trigger the next retry, resuming from a DB checkpoint. ~1,850 active
      # stocks need ~4 attempts, so 3 retries (4 attempts) left zero slack; 5
      # retries (6 attempts) gave comfortable margin.
      max_retries = local.job_max_retries
      timeout     = "${local.job_timeout_seconds}s"

      containers {
        # MONOLITH: the shorted-jobs image (ENTRYPOINT /shorted); command is set
        # explicitly so the args are unambiguous.
        # LEGACY: image's own CMD (python comprehensive_daily_sync.py), which is
        # why command/args are null rather than [] in that mode.
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
        # EXPLICITLY because it used to come from the Python image's own
        # `ENV SYNC_DAYS_SHORTS=7` (services/daily-sync/Dockerfile) and the
        # distroless monolith image carries no ENV at all. The value is the
        # same 7 in both modes (the Go job's compiled default), so this is a
        # documentation change, not a behaviour change.
        env {
          name  = "SYNC_DAYS_SHORTS"
          value = tostring(var.sync_days_shorts)
        }

        # NOT set, in either mode: SYNC_ALGOLIA (and therefore ALGOLIA_APP_ID /
        # ALGOLIA_ADMIN_KEY / ALGOLIA_SYNC_URL / ALGOLIA_SYNC_TOKEN). The
        # Python job gated its Algolia trigger on SYNC_ALGOLIA=="true" and the
        # Go job on GetEnvBool("SYNC_ALGOLIA", false) — both OFF here today, so
        # the cutover changes nothing. Algolia is reindexed out of band.
        #
        # Also NOT set: SYNC_DAYS_STOCK_PRICES, SYNC_KEY_METRICS,
        # ALPHA_VANTAGE_API_KEY, MAX_STOCK_FAILURE_RETRIES. The Go job does not
        # sync prices or key metrics (`shorted market-data` owns stock_prices;
        # the shorts API's key-metrics-scheduler owns key_metrics) and warns
        # loudly if any of them IS set. SYNC_DAYS_STOCK_PRICES=5 still arrives
        # from the legacy image's ENV in rollback mode — deliberately left
        # alone so the rollback is byte-identical to the pre-cutover job.

        # Event-driven cache revalidation: after writing new ASIC data, ping the
        # frontend to bust the cached SSR pages (fires only when data changed).
        env {
          name  = "REVALIDATION_URL"
          value = var.revalidation_url
        }

        # Mounted only when the secret exists; otherwise BOTH implementations
        # skip revalidation gracefully — the Go job's platform.PingRevalidate
        # no-ops on an unset REVALIDATION_URL/REVALIDATION_SECRET and never
        # fails the run (see manage_revalidation_secret).
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
    # A `true` toggle with no monolith image would silently fall back to an
    # empty image reference; fail at PLAN time instead. (Cross-variable
    # `validation` blocks need Terraform >= 1.9; this module's environments
    # only require >= 1.5, so the check lives here.)
    precondition {
      condition     = !var.use_go_monolith || var.shorted_jobs_image != ""
      error_message = "use_go_monolith = true requires shorted_jobs_image (the consolidated `shorted` binary image). Set it, or set use_go_monolith = false to run the legacy daily-sync Python image."
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

