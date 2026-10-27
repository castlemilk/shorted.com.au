variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "image_url" {
  description = "Docker image URL for the enrichment processor"
  type        = string
}

variable "postgres_address" {
  description = "PostgreSQL database address"
  type        = string
}

variable "postgres_database" {
  description = "PostgreSQL database name"
  type        = string
}

variable "postgres_username" {
  description = "PostgreSQL database username"
  type        = string
}

variable "topic_name_suffix" {
  description = "Optional suffix for Pub/Sub topic and subscription names (e.g., for preview environments)"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag for forcing new revisions"
  type        = string
  default     = ""
}

variable "shorts_api_url" {
  description = "URL of the shorts API service (for Algolia sync callbacks after enrichment)"
  type        = string
  default     = ""
}

variable "logo_bucket" {
  description = "GCS bucket for company and key-person image uploads (GCS_LOGO_BUCKET)"
  type        = string
  default     = "shorted-company-logos-prod"
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
