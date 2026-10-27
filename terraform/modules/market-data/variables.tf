variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run deployment"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g., production, dev)"
  type        = string
}

variable "image_url" {
  description = "Docker image URL for the market-data service"
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
  default     = 10
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
