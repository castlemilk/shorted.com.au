# -----------------------------------------------------------------------------
# Intraday poll — `shorted short-data-sync -poll`
# -----------------------------------------------------------------------------
# Kept OUT of main.tf on purpose: this body targets the v2 Admin API and so
# spells the deadline `timeout = "900s"`, while main.tf's daily trigger uses
# the v1 namespaces URL. scripts/tests/scheduler-override-body.test.mjs decides
# v1 vs v2 per FILE, so mixing them would (rightly) look like the #436 bug.
#
# The poll is the SAME job with one extra container arg, passed as a
# per-execution override. roles/run.invoker (main.tf, scheduler_invoker)
# carries run.jobs.run but NOT run.jobs.runWithOverrides, so an overrides body
# from the invoker SA alone is refused. That permission is in
# roles/run.developer, granted here to the scheduler's service account and
# SCOPED TO THIS ONE JOB — the same shape and
# reasoning as the picks / validate-sync grants in environments/prod/main.tf:
#
#   * A job-scoped binding is writable by the CI deploy SA; a project-level
#     one 403s on every apply. It also keeps the blast radius to this job:
#     nothing else in the fleet becomes override-able by this identity.
#   * What the override can say is fixed HERE, not by a caller: the body below
#     is a literal (`short-data-sync -poll`, 900s), and Cloud Scheduler has no
#     input path. The worst a misuse of this SA can do is run this job with
#     different args — it already holds run.jobs.run on it.
#
# The invoker binding stays: the daily trigger posts no overrides and needs
# nothing more. If the poll is ever removed, remove this binding with it
# (enable_poll_schedule = false does both).
resource "google_cloud_run_v2_job_iam_member" "scheduler_poll_overrides" {
  count = var.enable_poll_schedule ? 1 : 0

  name     = google_cloud_run_v2_job.short_data_sync.name
  location = google_cloud_run_v2_job.short_data_sync.location
  project  = var.project_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# Cloud Scheduler Job - intraday poll (weekdays, around ASIC's 11:30
# publication). Targets the v2 Admin API, which accepts the overrides body;
# the daily trigger keeps its v1 URL.
resource "google_cloud_scheduler_job" "poll_sync" {
  count = var.enable_poll_schedule ? 1 : 0

  name             = "${local.service_name}-poll"
  description      = "Intraday poll for new ASIC short selling files (short-data-sync -poll); ingests only new files, no reconcile"
  schedule         = var.poll_schedule
  time_zone        = "Australia/Sydney" # ASIC publishes at 11:30 local, in both AEST and AEDT
  attempt_deadline = "600s"
  region           = var.scheduler_region
  project          = var.project_id
  paused           = var.scheduler_paused

  # One retry: the next poll is 15 minutes away and the daily run is the
  # backstop, so a failed trigger is cheap to drop.
  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.short_data_sync.name}:run"
    headers = {
      "Content-Type" = "application/json"
    }
    # A poll that finds files runs the forward window + MV refresh, minutes at
    # most; 900s caps a wedged poll well under the daily run's 3600s.
    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{ args = ["short-data-sync", "-poll"] }]
        timeout            = "900s"
      }
    }))

    oauth_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_job.short_data_sync,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_cloud_run_v2_job_iam_member.scheduler_poll_overrides,
  ]
}
