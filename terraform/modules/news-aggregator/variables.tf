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
