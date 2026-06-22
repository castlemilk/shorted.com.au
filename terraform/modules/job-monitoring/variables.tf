variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "alert_recipient_email" {
  description = "Email address for Cloud Run Job failure + ERROR/timeout alerts. If empty, no notification channel or alert policies are created (module is a no-op)."
  type        = string
  default     = ""
}
