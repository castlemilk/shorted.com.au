terraform {
  required_providers {
    time = {
      source  = "hashicorp/time"
      version = "0.14.2"
    }
  }
}

/**
 * Housing Ingest Module
 *
 * The dedicated CrawlIngestService (S-ING, S-SRV): a Cloud Run service built from the
 * shorts API image with SHORTS_SERVE_MODE=ingest. It mounts only the crawl ingest and
 * health, on its own small database pool, so the public API's pool and routes are not
 * shared with rigs. Rigs push sweeps to it with BrandBrain-issued workload tokens, and
 * the service verifies those itself.
 *
 * It is NOT behind api.shorted.com.au or the Cloudflare edge worker. Those apply public
 * edge rate limits and the public API's auth chain, and neither fits a rig. Rigs use this
 * service's run.app URL. A custom domain is a follow-up.
 *
 * SHIPPED INERT. HOUSING_INGEST_ORG and HOUSING_INGEST_ALLOW_SUBJECTS are empty, so the
 * service's config reports a problem and it answers every call with Unavailable. No rig is
 * accepted until a reviewed change lists one (docs/feature/housing/operations.md, "Server-side
 * crawl jobs").
 *
 * Connection budget: at most max_instances * db_max_conns = 2 * 4 = 8 connections to
 * Supabase. The ingest pool is the smallest in the project, and the job's pool is 4.
 */

locals {
  service_name = "housing-ingest"
  labels = {
    service     = "housing-ingest"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "ingest" {
  account_id   = local.service_name
  display_name = "Housing Crawl Ingest"
  description  = "Runtime identity of the housing crawl ingest. Its only secret is DATABASE_URL. It has no BrandBrain, GCS or Cloud Run admin access."
  project      = var.project_id
}

# DATABASE_URL, the same secret the collector job reads. The ingest falls back to it
# when HOUSING_INGEST_DATABASE_URL is unset.
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
  project   = var.project_id
}

# A new service account and a new read grant take a moment to reach Secret Manager.
# Cloud Run refuses a revision that mounts a secret the service account cannot yet
# read, so the first apply that creates the grant waits 30s before the service. The
# same fix as chat-service (commit bffa7bdf0).
resource "time_sleep" "database_url_grant" {
  create_duration = "30s"

  depends_on = [google_secret_manager_secret_iam_member.database_url]
}

resource "google_cloud_run_v2_service" "ingest" {
  name     = local.service_name
  location = var.region
  project  = var.project_id
  labels   = local.labels
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.ingest.email
    timeout         = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image_url

      ports {
        container_port = 9091
        name           = "http1"
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      # Selects the dedicated ingest service in the shared image (services/shorts/cmd/server).
      env {
        name  = "SHORTS_SERVE_MODE"
        value = "ingest"
      }

      env {
        name  = "HOUSING_INGEST_ENABLED"
        value = "true"
      }

      env {
        name  = "HOUSING_INGEST_DB_MAX_CONNS"
        value = tostring(var.db_max_conns)
      }

      # The TTL the enqueue writes into crawl_dispatch.expires_at. The ingest checks that
      # column, not this value. It is set here so the two sides say the same thing.
      env {
        name  = "HOUSING_INGEST_DISPATCH_TTL"
        value = var.dispatch_ttl
      }

      # INERT by default. An empty org and an empty allowlist are config problems, so the
      # service answers Unavailable to every rig. Both come from variables that default to
      # empty and that prod leaves unset. Admitting a rig is a reviewed change to those.
      env {
        name  = "HOUSING_INGEST_ORG"
        value = var.ingest_org
      }

      env {
        name  = "HOUSING_INGEST_ALLOW_SUBJECTS"
        value = var.ingest_allow_subjects
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
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 9091
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 9091
        }
        initial_delay_seconds = 30
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    time_sleep.database_url_grant,
  ]
}

# Public invoker. Rigs do not hold Google identity. They authenticate with BrandBrain
# workload tokens, which CrawlIngestService verifies itself (services/pkg/workloadauth).
# The public invoker only lets the request reach the process, and every RPC still
# needs a verified token and an allowlisted rig.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.ingest.name
  location = google_cloud_run_v2_service.ingest.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}
