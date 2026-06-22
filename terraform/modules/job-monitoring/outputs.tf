output "notification_channel_id" {
  description = "ID of the email notification channel (empty if disabled)"
  value       = local.enabled ? google_monitoring_notification_channel.email[0].id : ""
}

output "alert_policy_id" {
  description = "ID of the Cloud Run Job failure alert policy (empty if disabled)"
  value       = local.enabled ? google_monitoring_alert_policy.cloud_run_job_failed[0].id : ""
}

output "log_alert_policy_id" {
  description = "ID of the Cloud Run Job ERROR/timeout log alert policy (empty if disabled)"
  value       = local.enabled ? google_monitoring_alert_policy.job_log_errors[0].id : ""
}
