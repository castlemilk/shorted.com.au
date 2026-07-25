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
  description = "Docker image URL for the news-aggregator job"
  type        = string
}

# Cutover switch: the consolidated `shorted news` job (modules/shorted-job,
# module.shorted_job_news — ONE job, five schedules) takes over ALL FIVE of this
# module's schedulers (periodic / backfill-images / resolve-googlenews / cluster
# / digest). The old job stays deployed (and manually executable) with every
# scheduler paused until one green scheduled run of the replacement; rollback =
# flip this back to false and pause the new module.
variable "scheduler_paused" {
  description = "Pause ALL five of this job's Cloud Scheduler triggers (used during the shorted-jobs consolidation cutover)"
  type        = bool
  default     = false
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}

variable "gemini_secret_exists" {
  description = "Whether the GEMINI_API_KEY secret exists in Secret Manager"
  type        = bool
  default     = false
}

variable "gemini_secret_name" {
  description = "Secret Manager secret name containing this job's Gemini API key"
  type        = string
  default     = "GEMINI_API_KEY"
}

variable "email_img_secret_exists" {
  description = "Whether the EMAIL_IMG_SECRET secret exists in Secret Manager (HMAC key for signing digest thumbnail proxy URLs)"
  type        = bool
  default     = false
}

variable "public_site_url" {
  description = "Public origin used by the weekly digest for absolute links and signed image URLs"
  type        = string
  default     = "https://shorted.com.au"
}
