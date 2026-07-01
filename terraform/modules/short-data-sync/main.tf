/**
 * Short Data Sync Module
 * 
 * Manages:
 * - Cloud Run Job for syncing ASIC short selling data
 * - Service account and IAM permissions
 * - Cloud Scheduler job (daily trigger)
 * - GCS bucket for storing CSV files
 */

locals {
  service_name = "shorts-data-sync" # Match existing job name
  labels = {
    service     = "short-data-sync"
    environment = var.environment
    managed_by  = "terraform"
  }
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

      # The script processes SYNC_BATCH_SIZE (500) stocks per attempt (~5h each) and
      # exits 2 to trigger the next retry, resuming from a DB checkpoint. ~1,850 active
      # stocks need ~4 attempts, so 3 retries (4 attempts) left zero slack: one attempt
      # cut short (e.g. a Cloud Run maintenance cycle) meant the execution ran out of
      # retries still partial and paged. 5 retries (6 attempts) gives comfortable margin;
      # attempts stop as soon as the sync completes, so the extra retries cost nothing on
      # a healthy day.
      max_retries = 5
      timeout     = "28800s" # 8h per attempt — a full 500-stock batch takes ~5h via the rate-limited Yahoo/Alpha price fetches

      containers {
        image = var.image_url
        # Use Dockerfile's default CMD: python comprehensive_daily_sync.py
        # NOTE: the deployed image is built from services/daily-sync/Dockerfile
        # (CMD ["python","comprehensive_daily_sync.py"]) — NOT services/short-data-sync/.
        # Do not override the command here unless you also repoint the build.

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

        # Event-driven cache revalidation: after writing new ASIC data, ping the
        # frontend to bust the cached SSR pages (fires only when data changed).
        env {
          name  = "REVALIDATION_URL"
          value = var.revalidation_url
        }

        # Mounted only when the secret exists; otherwise main.py skips
        # revalidation gracefully (see manage_revalidation_secret).
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

