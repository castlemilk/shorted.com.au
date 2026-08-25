# Job monitoring — GCP-native crash + error backstop for all scheduled jobs.
#
# Two complementary alerts, both free Cloud Monitoring config (no DB, no app code):
#  1. cloud_run_job_failed   — fires when a Cloud Run Job EXECUTION is marked
#     failed (non-zero exit, OOM, startup failure). Catches hard crashes like the
#     director-trade-extractor exit(1) on a missing API key.
#  2. job_log_errors         — fires on ERROR-severity logs or "Terminating task
#     … timeout" terminations. Catches the silent class the count metric misses:
#     a job that exits 0 having done nothing, or runs to its timeout (e.g. the
#     short-data-sync uvicorn-zombie that sat "running" for ~18h).
#
# The filters match resource.type="cloud_run_job", so EVERY Cloud Run Job in the
# project is covered automatically — no per-job allowlist to maintain. The one
# escape hatch is var.excluded_job_names, a DENY list for jobs that carry their
# own alerting (see its description before adding to it).
#
# All resources are gated on alert_recipient_email, so the module is a no-op
# until an address is provided.

locals {
  enabled = var.alert_recipient_email != ""

  # Per-job opt-outs, appended to both policy filters. `resource.label` is the
  # metric-based policy's spelling; the log-based policy only carries the job
  # name as an extracted METRIC label, hence the two lists.
  excluded_resource_clauses = [
    for job in var.excluded_job_names : "resource.label.\"job_name\" != \"${job}\""
  ]
  excluded_metric_clauses = [
    for job in var.excluded_job_names : "metric.label.\"job_name\" != \"${job}\""
  ]
}

# Email notification channel.
resource "google_monitoring_notification_channel" "email" {
  count        = local.enabled ? 1 : 0
  project      = var.project_id
  display_name = "Job alerts (email)"
  type         = "email"

  labels = {
    email_address = var.alert_recipient_email
  }
}

# Alert 1: any Cloud Run Job had a FAILED execution. Grouped by job name so each
# failing job raises its own incident.
resource "google_monitoring_alert_policy" "cloud_run_job_failed" {
  count        = local.enabled ? 1 : 0
  project      = var.project_id
  display_name = "Cloud Run Job execution failed"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "A Cloud Run Job execution failed"

    condition_threshold {
      filter = join(" AND ", concat([
        "resource.type = \"cloud_run_job\"",
        "metric.type = \"run.googleapis.com/job/completed_execution_count\"",
        "metric.label.\"result\" = \"failed\"",
      ], local.excluded_resource_clauses))
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"job_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  documentation {
    content   = "A Cloud Run Job execution failed (non-zero exit / OOM / startup failure). Check the job's logs in Cloud Run and the admin Jobs overview at /admin."
    mime_type = "text/markdown"
  }

  alert_strategy {
    # Auto-close if no further failures for 30m (the next successful scheduled run
    # is the real "all clear"; this just keeps incidents tidy).
    auto_close = "1800s"
  }
}

# Log-based metric: ERROR-severity lines or timeout/deadline terminations from any
# Cloud Run Job, labelled by job name.
resource "google_logging_metric" "job_errors" {
  count   = local.enabled ? 1 : 0
  project = var.project_id
  name    = "cloud_run_job_errors"
  filter = join(" AND ", [
    "resource.type=\"cloud_run_job\"",
    "(severity>=ERROR OR textPayload:\"Terminating task\" OR textPayload:\"DeadlineExceeded\")",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "job_name"
      value_type  = "STRING"
      description = "Cloud Run Job name"
    }
  }

  label_extractors = {
    "job_name" = "EXTRACT(resource.labels.job_name)"
  }
}

# Alert 2: a Cloud Run Job logged an ERROR or hit a timeout termination. Catches
# the "exit 0 but did nothing" / zombie-timeout class the count metric misses.
resource "google_monitoring_alert_policy" "job_log_errors" {
  count        = local.enabled ? 1 : 0
  project      = var.project_id
  display_name = "Cloud Run Job logged ERROR / timeout"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "A Cloud Run Job emitted an ERROR log or timed out"

    condition_threshold {
      filter = join(" AND ", concat([
        "resource.type = \"cloud_run_job\"",
        "metric.type = \"logging.googleapis.com/user/${google_logging_metric.job_errors[0].name}\"",
      ], local.excluded_metric_clauses))
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.\"job_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  documentation {
    content   = "A Cloud Run Job logged an ERROR-severity line or was terminated for hitting its task timeout. Catches jobs that exit 0 having done nothing and runs that hang to their deadline. Tune the log filter if a job emits non-fatal ERRORs. Check logs + /admin."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "1800s"
  }
}
