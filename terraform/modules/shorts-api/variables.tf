variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run service"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the Cloud Run service"
  type        = string
}

variable "min_instances" {
  description = "Minimum number of Cloud Run instances"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 100
}

variable "postgres_address" {
  description = "PostgreSQL server address (transaction pooler port 6543 recommended for Cloud Run)"
  type        = string
  default     = "aws-0-ap-southeast-2.pooler.supabase.com:6543"
}

variable "postgres_database" {
  description = "PostgreSQL database name"
  type        = string
  default     = "postgres"
}

variable "postgres_username" {
  description = "PostgreSQL username"
  type        = string
  default     = "postgres.xivfykscsdagwsreyqgf"
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}

variable "scheduler_region" {
  description = "Region for Cloud Scheduler (must be australia-southeast1)"
  type        = string
  default     = "australia-southeast1"
}

variable "enable_key_metrics_scheduler" {
  description = "Enable daily Cloud Scheduler for key metrics sync"
  type        = bool
  default     = false
}

variable "custom_domain" {
  description = "Custom domain to map to the Cloud Run service (e.g. api.shorted.com.au). Leave empty to skip."
  type        = string
  default     = ""
}

