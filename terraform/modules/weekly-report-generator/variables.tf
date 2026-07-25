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
