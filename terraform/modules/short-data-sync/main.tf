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
  service_name = "shorts-data-sync"  # Match existing job name
  labels = {
    service     = "short-data-sync"
    environment = var.environment
    managed_by  = "terraform"
  }
}

# GCS Bucket for short selling data (existing bucket name format)
resource "google_storage_bucket" "short_selling_data" {
  name          = "shorted-short-selling-data"  # Match existing bucket name
  location      = "US"  # Match existing bucket location (multi-region)
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
      autoclass,  # Ignore autoclass if it was enabled manually
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

      max_retries = 3
      timeout     = "3600s" # 1 hour

      containers {
        image   = var.image_url
        # Use Dockerfile's default CMD: python comprehensive_daily_sync.py

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
            cpu    = "2"
            memory = "4Gi"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
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
  attempt_deadline = "1800s"  # 30 minutes (max allowed by Cloud Scheduler)
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

