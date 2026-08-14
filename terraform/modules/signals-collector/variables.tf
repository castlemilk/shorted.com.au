variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for the Cloud Run job"
  type        = string
  default     = "australia-southeast2"
}

variable "scheduler_region" {
  description = "GCP region for Cloud Scheduler (only australia-southeast1 is supported)"
  type        = string
  default     = "australia-southeast1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the signals-collector job"
  type        = string
}

variable "brandbrain_url" {
  description = "Base URL of the brandbrain DiscoveryService (Connect JSON)"
  type        = string
  default     = "https://api.brandbrain.dev"
}

variable "sweep_limit" {
  description = "Max stocks to process per scheduled sweep (bounded to respect brandbrain capacity)"
  type        = number
  default     = 200
}

variable "max_age_days" {
  description = "Skip stocks whose signals were fetched within this many days (skip-fresh)"
  type        = number
  default     = 30
}

variable "schedule" {
  description = "Cloud Scheduler cron (UTC). Default: Mondays 13:00 UTC (11 PM AEST)."
  type        = string
  default     = "0 13 * * 1"
}

# Cutover switch: the consolidated `shorted signals` job (modules/shorted-job,
# module.shorted_job_signals) takes over this schedule. The old job stays
# deployed (and manually executable) with its scheduler paused until one green
# scheduled run of the replacement; rollback = flip this back to false and pause
# the new module.
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
