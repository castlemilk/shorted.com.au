variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "alert_recipient_email" {
  description = "Email address for Cloud Run Job failure + ERROR/timeout alerts. If empty, no notification channel or alert policies are created (module is a no-op)."
  type        = string
  default     = ""
}

variable "excluded_job_names" {
  description = "Cloud Run Job names whose failures must NOT email. Only for jobs that carry their OWN alerting — a second, less specific page is noise. Anything listed here loses its GCP-side backstop, so list nothing whose failure would otherwise go unnoticed."
  type        = list(string)
  default     = []
}
