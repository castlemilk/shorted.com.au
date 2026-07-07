variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for the Cloud Run jobs"
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
  description = "Docker image URL shared by both report-extractor jobs"
  type        = string
}

variable "gemini_secret_exists" {
  description = "Whether the GEMINI_API_KEY secret exists in this project (both jobs need it)"
  type        = bool
  default     = false
}

variable "gemini_secret_name" {
  description = "Secret Manager secret name containing this module's Gemini API key"
  type        = string
  default     = "GEMINI_API_KEY"
}

variable "reports_bucket" {
  description = "GCS bucket for digest raw-text uploads (GCS_REPORTS_BUCKET)"
  type        = string
  default     = "shorted-financial-reports"
}

variable "director_limit" {
  description = "Max director-trade PDFs to process per daily run"
  type        = number
  default     = 20
}

variable "reports_limit" {
  description = "Max financial reports to process per weekly run"
  type        = number
  default     = 10
}

variable "director_schedule" {
  description = "Cloud Scheduler cron (UTC) for the director extractor. Default: daily 12:30 UTC (after the announcement crawler)."
  type        = string
  default     = "30 12 * * *"
}

variable "reports_schedule" {
  description = "Cloud Scheduler cron (UTC) for the financial-report extractor. Default: Sundays 14:00 UTC."
  type        = string
  default     = "0 14 * * 0"
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}
