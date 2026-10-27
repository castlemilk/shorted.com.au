variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run job"
  type        = string
  default     = "australia-southeast2"
}

variable "scheduler_region" {
  description = "GCP region for Cloud Scheduler"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the weekly-report-generator Cloud Run job"
  type        = string
}

# Cutover switch: the consolidated `shorted weekly-report` job
# (modules/shorted-job, module.shorted_job_weekly_report) takes over BOTH of
# this module's schedulers (weekly + monthly). The old job stays deployed (and
# manually executable) with both schedulers paused until one green scheduled run
# of the replacement; rollback = flip this back to false and pause the new
# module.
variable "scheduler_paused" {
  description = "Pause both of this job's Cloud Scheduler triggers (used during the shorted-jobs consolidation cutover)"
  type        = bool
  default     = false
}

variable "gemini_secret_exists" {
  description = "Whether GEMINI_API_KEY secret exists in Secret Manager"
  type        = bool
  default     = false
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}

variable "otel_metrics" {
  description = "Optional metrics-only OTLP routing. Enable after the dedicated header secret is provisioned; generic OTLP trace settings are unchanged."
  type = object({
    enabled        = optional(bool, false)
    endpoint       = optional(string, "")
    headers_secret = optional(string, "")
  })
  default = {}

  validation {
    condition = !var.otel_metrics.enabled || (
      can(regex("^https://[^/@?#[:space:]]+/v1/metrics$", var.otel_metrics.endpoint)) &&
      can(regex("^[A-Za-z0-9_-]+$", var.otel_metrics.headers_secret)) &&
      var.otel_metrics.headers_secret != "OTEL_EXPORTER_OTLP_HEADERS"
    )
    error_message = "Enabled metrics routing requires an HTTPS /v1/metrics endpoint without credentials/query and a dedicated Secret Manager header-secret ID; generic Grafana credentials must not be reused."
  }
}
