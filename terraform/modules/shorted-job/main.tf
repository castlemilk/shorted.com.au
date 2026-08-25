/**
 * Shorted Job Module (generic)
 *
 * ONE reusable Cloud Run Job + Cloud Scheduler + invoker service account for
 * the consolidated `shorted <subcommand> [flags]` binary (services/jobs).
 *
 * Replaces the copy-pasted per-job modules one migration at a time: each
 * instantiation is the same image with different `args`, resources and cron.
 * Resource shapes were lifted verbatim from the old modules/economy-collector +
 * modules/asx-announcement-crawler (both since deleted) — no new patterns.
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

  # An empty `schedule` means the job has no Cloud Scheduler trigger at all —
  # it is executed by an external caller (a GitHub workflow, the admin console)
  # — so neither the scheduler job nor its invoker SA is created.
  create_scheduler = var.schedule != ""

  schedules_by_suffix = { for s in var.schedules : s.name_suffix => s }

  # The single container's override object for each extra schedule. `env` is
  # emitted as the Cloud Run v1 [{name, value}] list (map iteration is
  # key-sorted, so the payload is stable across plans).
  schedule_overrides = {
    for k, s in local.schedules_by_suffix : k => merge(
      s.args_override == null ? {} : { args = s.args_override },
      s.env_override == null ? {} : { env = [for name, value in s.env_override : { name = name, value = value }] },
    )
  }

  # Base64 scheduler body — null (no body posted, a plain :run) when the entry
  # declares no overrides. Encoding copied verbatim from the old
  # news-aggregator / weekly-report-generator schedulers.
  schedule_bodies = {
    for k, o in local.schedule_overrides : k => length(o) == 0 ? null : base64encode(jsonencode({
      overrides = {
        container_overrides = [o]
      }
    }))
  }

  # runWithOverrides is in roles/run.developer, NOT roles/run.invoker: any
  # schedule that posts an overrides body 403s without the extra binding.
  needs_run_developer = length([for k, b in local.schedule_bodies : k if b != null]) > 0
}

# Adopting `count` on the three scheduler resources would otherwise re-address
# every existing instantiation's state (`.schedule` -> `.schedule[0]`) and plan
# a destroy/create of live schedulers. These are no-ops where the address does
# not exist.
moved {
  from = google_service_account.scheduler_invoker
  to   = google_service_account.scheduler_invoker[0]
}

moved {
  from = google_cloud_run_v2_job_iam_member.scheduler_invoker
  to   = google_cloud_run_v2_job_iam_member.scheduler_invoker[0]
}

moved {
  from = google_cloud_scheduler_job.schedule
  to   = google_cloud_scheduler_job.schedule[0]
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

  lifecycle {
    precondition {
      condition     = local.create_scheduler || length(var.schedules) == 0
      error_message = "schedules[] requires a primary `schedule`: the extra schedulers reuse the invoker SA that an empty `schedule` does not create."
    }
  }
}

# Service account for Cloud Scheduler to invoke the job.
resource "google_service_account" "scheduler_invoker" {
  count = local.create_scheduler ? 1 : 0

  account_id   = "${var.name}-sched"
  display_name = "Shorted job scheduler: ${var.name}"
  description  = "Service account for Cloud Scheduler to invoke the ${var.name} job"
  project      = var.project_id

  lifecycle {
    precondition {
      # account_id is capped at 30 and this one appends "-sched"; the cap only
      # binds a job that actually gets a scheduler.
      condition     = length(var.name) <= 24
      error_message = "a scheduled job's name must be <= 24 characters (its invoker SA is '<name>-sched' and service-account IDs are capped at 30)."
    }
  }
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = local.create_scheduler ? 1 : 0

  name     = google_cloud_run_v2_job.job.name
  location = google_cloud_run_v2_job.job.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker[0].email}"
}

# Only created when at least one extra schedule posts an overrides body, so
# single-schedule instantiations are unaffected (count = 0 → no resource).
resource "google_cloud_run_v2_job_iam_member" "scheduler_developer" {
  count = local.needs_run_developer ? 1 : 0

  name     = google_cloud_run_v2_job.job.name
  location = google_cloud_run_v2_job.job.location
  project  = var.project_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.scheduler_invoker[0].email}"
}

resource "google_cloud_scheduler_job" "schedule" {
  count = local.create_scheduler ? 1 : 0

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
      service_account_email = google_service_account.scheduler_invoker[0].email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.job,
    google_cloud_run_v2_job_iam_member.scheduler_invoker
  ]
}

# Extra schedules (var.schedules) — same job, different cron, optionally with an
# args/env override payload. Kept as a SEPARATE for_each resource from the
# primary `schedule` above so that adding this feature does not re-address the
# existing single-schedule instantiations (no state moves, no plan diff).
resource "google_cloud_scheduler_job" "extra_schedule" {
  for_each = local.schedules_by_suffix

  name        = "${var.name}-${each.key}"
  description = each.value.description != "" ? each.value.description : "Scheduled run of `shorted ${join(" ", coalesce(each.value.args_override, var.args))}` (${each.key})"
  schedule    = each.value.cron
  time_zone   = "UTC"
  attempt_deadline = (
    each.value.attempt_deadline != null ? each.value.attempt_deadline : var.scheduler_attempt_deadline
  )
  region  = var.scheduler_region
  project = var.project_id
  paused  = each.value.paused != null ? each.value.paused : var.paused

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
      service_account_email = google_service_account.scheduler_invoker[0].email
    }

    # null when the entry declares no overrides → a plain :run, same as the
    # primary schedule.
    body = local.schedule_bodies[each.key]
  }

  depends_on = [
    google_cloud_run_v2_job.job,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_cloud_run_v2_job_iam_member.scheduler_developer,
  ]
}
