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
  default     = "australia-southeast1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the asx-announcement-crawler job"
  type        = string
}

# Cutover switch: the consolidated `shorted announcements ...` job
# (modules/shorted-job) takes over this schedule. The old job stays deployed
# (and manually executable) with its scheduler paused until one green
# scheduled run of the replacement; rollback = flip this back to false and
# pause the new module.
variable "scheduler_paused" {
  description = "Pause this job's Cloud Scheduler trigger (used during the shorted-jobs consolidation cutover)"
  type        = bool
  default     = false
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}
