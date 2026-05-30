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
  description = "GCP region for Cloud Scheduler (southeast1 — only region with Cloud Scheduler)"
  type        = string
  default     = "australia-southeast1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the take-writer newsroom job"
  type        = string
}

variable "schedule" {
  description = "Cron schedule (UTC) — default 20:00 UTC = 06:00 AEST"
  type        = string
  default     = "0 20 * * *"
}

variable "gemini_secret_exists" {
  description = "Whether GEMINI_API_KEY secret exists in Secret Manager"
  type        = bool
  default     = true
}

variable "anthropic_secret_exists" {
  description = "Whether ANTHROPIC_API_KEY secret exists in Secret Manager"
  type        = bool
  default     = true
}

variable "gcs_logo_bucket" {
  description = "GCS bucket name for company logos"
  type        = string
  default     = "shorted-company-logos"
}

variable "max_takes_per_day" {
  description = "Maximum number of takes to generate per daily run"
  type        = string
  default     = "10"
}

variable "max_deepdives_per_day" {
  description = "Maximum number of deep-dive takes to generate per daily run"
  type        = string
  default     = "2"
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}
