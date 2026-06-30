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

variable "resend_secret_exists" {
  description = "Whether the RESEND_API_KEY secret exists in Secret Manager. Gates binding the secret env (so apply doesn't fail before it's provisioned). The handler no-ops when the key is absent."
  type        = bool
  default     = false
}

variable "resend_to" {
  description = "Recipient address for new-subscriber notification emails (support@ is a Google Workspace inbox on shorted.com.au)."
  type        = string
  default     = "support@shorted.com.au"
}

variable "resend_from" {
  description = "From address for new-subscriber notification emails. shorted.com.au is a Resend-verified sending domain (resend._domainkey + send.shorted.com.au SES SPF in DNS)."
  type        = string
  default     = "Shorted <support@shorted.com.au>"
}

variable "unsubscribe_secret_exists" {
  description = "Whether the UNSUBSCRIBE_SECRET secret exists in Secret Manager (gates the secret env binding)."
  type        = bool
  default     = false
}

variable "broadcast_from" {
  description = "From header for newsletter broadcasts."
  type        = string
  default     = "Shorted <updates@shorted.com.au>"
}

variable "broadcast_reply_to" {
  description = "Reply-To for newsletter broadcasts."
  type        = string
  default     = "support@shorted.com.au"
}

