/**
 * House-Price Collector Module
 *
 * Cloud Run Job + Cloud Scheduler that runs services/house-price-collector in
 * its default mode (ABS + RBA official ingest + materialized-view refresh).
 * Monthly cadence catches the quarterly ABS releases (~10-11 weeks after quarter
 * end). No GCS bucket — the collector fetches ABS/RBA over HTTPS and writes to
 * Postgres. The supplementary crawl tier (-mode crawl) is NOT scheduled here.
 *
 * A second, daily schedule runs the same job in `-mode drop-index` (pure SQL
 * discounting-index snapshot for /price-drops) — see the
 * google_cloud_scheduler_job.daily_drop_index resource below for why this
 * runs on Cloud Run rather than the residential crawl rig.
 */

locals {
  service_name = "house-price-collector"
  labels = {
    service     = "house-price-collector"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "collector" {
  account_id   = local.service_name
  display_name = "House Price Collector Job"
  description  = "Service account for the ABS/RBA house-price collector"
  project      = var.project_id
}

# Read DATABASE_URL from Secret Manager.
resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = "DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collector.email}"
  project   = var.project_id
}

# Grant access to the revalidation secret (event-driven cache invalidation).
# Guarded: only when the secret actually exists (see manage_revalidation_secret).
resource "google_secret_manager_secret_iam_member" "revalidation_secret" {
  count     = var.manage_revalidation_secret ? 1 : 0
  secret_id = "REVALIDATION_SECRET"
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
        # Default ENTRYPOINT runs -mode all (official ingest + MV refresh).

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }
        env {
          name  = "HOUSING_OFFICIAL_MAX_FAILURES"
          value = tostring(var.official_max_failures)
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

        # Server-side crawl modes (S-SRV, crawl_server.go). None of these is read by the
        # default -mode all, so they change nothing for the official ingest. The
        # server-enqueue mode presents a Google ID token for BRANDBRAIN_IDTOKEN_AUDIENCE
        # from this job's service account, and it writes HOUSING_INGEST_DISPATCH_TTL into
        # crawl_dispatch.expires_at.
        env {
          name  = "BRANDBRAIN_AGENT_URL"
          value = var.brandbrain_url
        }
        env {
          name  = "BRANDBRAIN_IDTOKEN_AUDIENCE"
          value = var.brandbrain_idtoken_audience
        }
        env {
          name  = "HOUSING_INGEST_DISPATCH_TTL"
          value = var.ingest_dispatch_ttl
        }

        # Event-driven cache revalidation: after the official/crawl ingest
        # refreshes the housing MVs, ping the frontend to bust the cached SSR
        # pages (/price-drops, /housing). Fires only when the data changed.
        env {
          name  = "REVALIDATION_URL"
          value = var.revalidation_url
        }

        # Mounted only when the secret exists; otherwise the collector skips
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
  ]
}

# Service account for Cloud Scheduler to invoke the job.
resource "google_service_account" "scheduler_invoker" {
  account_id   = "${local.service_name}-sched"
  display_name = "House Price Collector Scheduler"
  description  = "Service account for Cloud Scheduler to invoke the house-price collector"
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
  description      = "Monthly ABS/RBA house-price ingest (catches quarterly releases)"
  schedule         = "0 16 5 * *" # 5th of month, 16:00 UTC (~2-3 AM AEST)
  time_zone        = "UTC"
  attempt_deadline = "1800s"
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.monthly_scheduler_paused

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

# The daily drop-index scheduler below posts a body containing
# `overrides.container_overrides` (to set `-mode drop-index` + a generous
# task timeout). That code path requires `run.jobs.runWithOverrides`, which is
# in `roles/run.developer` but NOT in `roles/run.invoker`. Without this
# binding the daily invocation 403s. (Same requirement as the monthly report
# scheduler in modules/weekly-report-generator.)
resource "google_cloud_run_v2_job_iam_member" "scheduler_developer" {
  name     = google_cloud_run_v2_job.collector.name
  location = google_cloud_run_v2_job.collector.location
  project  = var.project_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Daily discounting-index snapshot (/price-drops "drop index" hero + panel).
# Deliberately a SEPARATE, DAILY Cloud Run schedule rather than a step on the
# residential crawl rig: the rig is the fragile leg of this system (a deleted
# Playwright driver silently wedged it for two days in August 2026 — see
# housing-crawl-outage-modes memory), and pure-SQL index math has no reason to
# share that failure mode. An index that silently freezes at a stale number
# whenever Chrome breaks on the rig is worse for users than no index at all;
# running it here means it depends only on Cloud Run + Postgres.
#
# Schedule: 18:00 UTC daily = ~4:00 AM AEST. Chosen to clear both residential
# crawl windows (fortnightly full crawl starts 22:00 UTC prior day; daily
# delta crawl starts 00:00 UTC) by several hours in either direction, and to
# sit 2 hours clear of the existing monthly official-ingest run (16:00 UTC on
# the 5th) on the one day a month they could otherwise land close together.
resource "google_cloud_scheduler_job" "daily_drop_index" {
  name             = "${local.service_name}-drop-index"
  description      = "Daily discounting-index snapshot for /price-drops (pure SQL, no crawl)"
  schedule         = "0 18 * * *" # 18:00 UTC daily (~4 AM AEST)
  time_zone        = "UTC"
  attempt_deadline = "1800s" # Cloud Scheduler's platform maximum for an HTTP target
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.drop_index_scheduler_paused

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

    # attempt_deadline above only bounds how long Scheduler waits on the :run
    # HTTP call, not how long the job itself may run. drop-index writes a row
    # per suburb per day, so a first run (or any operator-triggered backfill
    # via DROP_INDEX_FROM) can span many days of history; override the task
    # timeout generously (4h, matching the collector's own CRAWL_TIMEOUT_MIN
    # default for this mode — see collectorTimeoutMinutes in main.go) rather
    # than inherit the 30-min timeout sized for the small monthly ingest.
    #
    # NOTE the field name. The uri above is the Cloud Run Admin API **v1**
    # (`/apis/run.googleapis.com/v1/namespaces/...:run`), whose `Overrides`
    # message spells the task deadline `timeoutSeconds` as an INTEGER number of
    # seconds. The v2 API's `timeout` duration-string spelling ("14400s") does
    # not exist on v1: posting it makes the API reject the whole request with
    #   400 Invalid JSON payload received. Unknown name "timeout" at
    #   'overrides': Cannot find field.
    # which Cloud Scheduler surfaces only as status code 3 / INVALID_ARGUMENT.
    # That mistake shipped in #436 and meant this schedule never once ran (see
    # the drop-index catch-up note in docs/feature/housing/operations.md).
    # `container_overrides` snake_case is fine — proto JSON accepts both
    # spellings; it is only the field NAME that must exist on v1.
    body = base64encode(jsonencode({
      overrides = {
        container_overrides = [{
          args = ["-mode", "drop-index"]
        }]
        timeoutSeconds = 14400
      }
    }))
  }

  depends_on = [
    google_cloud_run_v2_job.collector,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_cloud_run_v2_job_iam_member.scheduler_developer,
  ]
}

# ---------------------------------------------------------------------------
# Server-side crawl jobs (fleet-managed housing crawl, S-SRV).
#
# These run this same job with different args, and they replace the rig's database
# work. A rig fetches and pushes to the ingest service, and it holds no database
# credential. Design: docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md
#
#   enqueue-delta     server-enqueue -selection delta    daily 10:00
#   enqueue-full      server-enqueue -selection full     1st and 15th, 08:00
#   crawl-finalize    crawl-finalize                     every 30 min, a no-op unless the ingest wrote
#   freshness         freshness                          daily 18:00 (exit 6 is the alarm, unchanged)
#   property-resolve  server-property-resolve, CRAWL_DRY_RUN=false, cap 700   daily 21:20
#
# Every schedule is PAUSED while var.server_schedules_paused is true (the default).
# Cutover runbook: docs/feature/housing/operations.md "Server-side crawl jobs".
# Scheduler bodies use the Cloud Run v1 :run spelling (see scheduler-override-body.test.mjs).
# ---------------------------------------------------------------------------
locals {
  server_crawl_schedules = {
    enqueue-delta = {
      description = "Server enqueue, delta selection: post demand-sized suburbs to BrandBrain and write their ledger rows (S-SRV)"
      schedule    = "0 10 * * *"
      args        = ["-mode", "server-enqueue", "-selection", "delta"]
      env         = {}
    }
    enqueue-full = {
      description = "Server enqueue, the whole catalog, twice a month (S-SRV)"
      schedule    = "0 8 1,15 * *"
      args        = ["-mode", "server-enqueue", "-selection", "full"]
      env         = {}
    }
    crawl-finalize = {
      description = "Sal links, housing MV refresh and one cache bust, only when the fleet's ingest has written since the last run (S-SRV)"
      schedule    = "*/30 * * * *"
      args        = ["-mode", "crawl-finalize"]
      env         = {}
    }
    freshness = {
      description = "Read-only crawl freshness check; exit 6 is the alarm (S-SRV)"
      schedule    = "0 18 * * *"
      args        = ["-mode", "freshness"]
      env         = {}
    }
    # The cap is sized to the job's 1800s timeout, not the rig's 3000. At the default pacing
    # (900-2200 ms, mean 1.55 s) plus a few hundred ms of request time, one address costs about
    # 1.85 s. 1000 addresses would need ~1850 s, over the timeout, so the cap is 700: ~1300 s,
    # leaving ~500 s of slack for slow responses. The backlog is ~48k addresses, so a daily 700
    # clears it in months, not hours. The server-property-resolve mode maps a blocked run (exit 3)
    # to exit 0, as the rig wrapper does.
    property-resolve = {
      description = "Bank property.com.au profile URLs from REA's public autocomplete, no browser (S-SRV). Dry-run is off and the chunk is 700 for this schedule only."
      schedule    = "20 21 * * *"
      args        = ["-mode", "server-property-resolve"]
      env = {
        CRAWL_DRY_RUN              = "false"
        CRAWL_PROPERTY_RESOLVE_MAX = "700"
      }
    }
  }
}

resource "google_cloud_scheduler_job" "server_crawl" {
  for_each = local.server_crawl_schedules

  name             = "${local.service_name}-${each.key}"
  description      = each.value.description
  schedule         = each.value.schedule
  time_zone        = "Australia/Sydney"
  attempt_deadline = "1800s" # Cloud Scheduler's platform maximum for an HTTP target
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.server_schedules_paused

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

    # The v1 Overrides message, so container_overrides and its env list, never the v2
    # spelling. See the drop-index schedule above for the field-name history.
    body = base64encode(jsonencode({
      overrides = {
        container_overrides = [{
          args = each.value.args
          env  = [for k, v in each.value.env : { name = k, value = v }]
        }]
      }
    }))
  }

  depends_on = [
    google_cloud_run_v2_job.collector,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_cloud_run_v2_job_iam_member.scheduler_developer,
  ]
}
