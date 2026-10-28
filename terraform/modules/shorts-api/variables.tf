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

variable "resend_webhook_secret_exists" {
  description = "Whether the RESEND_WEBHOOK_SECRET secret exists in Secret Manager. Gates binding the secret env and its IAM grant. Unset, the Resend webhook (/webhooks/resend) answers 503 and changes nothing else."
  type        = bool
  default     = false
}

variable "resend_from" {
  description = "From address for new-subscriber notification emails. shorted.com.au is a Resend-verified sending domain (resend._domainkey + send.shorted.com.au SES SPF in DNS)."
  type        = string
  default     = "Shorted <support@shorted.com.au>"
}

variable "telesis_secret_exists" {
  description = "Whether the TELESIS_API_TOKEN secret exists in Secret Manager. Gates the secret binding and its IAM grant, so apply is safe before it is provisioned. Without it the admin job monitor cannot read Telesis, and jobs on the omega cluster read as paused and overdue."
  type        = bool
  default     = false
}

variable "brandbrain_housing_grant_secret_exists" {
  description = "Whether the brandbrain-housing-grant-token secret exists in Secret Manager. Gates the secret binding, its IAM grant and the BRANDBRAIN_HOUSING_GRANT_TOKEN env var, so apply is safe before it is provisioned. Without it the admin housing-crawl write tool answers not_configured. Flip to true in the environment after creating the secret."
  type        = bool
  default     = false
}

variable "telesis_org_id" {
  description = "Telesis organisation that owns the shorted cron monitors (TELESIS_ORG_ID)."
  type        = string
  default     = ""
}

variable "telesis_service_id" {
  description = "Telesis service the cron monitors hang on (\"shorted.com.au scheduled jobs\"). Required when the project token is scoped to it, which it should be."
  type        = string
  default     = ""
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


variable "shorts_data_bucket" {
  description = <<-EOT
    GCS bucket holding the shorts-data-sync job's artifacts, in particular the
    per-stock validation reports at validations/<execution>.json that
    GET /api/admin/jobs/validate-sync reads.

    Passed in rather than derived: the bucket is OWNED by the short-data-sync
    module, which also grants this service objectViewer on it (its
    var.reader_service_accounts). Reading the name from that module's output
    here would make the two modules mutually dependent, so both are wired from
    one local in environments/*/main.tf.

    Empty disables retrieval (the endpoint answers 503 not_configured). There
    is deliberately no default — prod and dev use different bucket names.
  EOT
  type        = string
  default     = ""
}

variable "rate_limit_enabled" {
  description = "Turn on app-layer rate limiting: per-tier per-minute (in process) and monthly quota accounting (Postgres). Requires no storage configuration."
  type        = bool
  default     = false
}

variable "rate_limit_ssr_bypass_secret" {
  description = "Shared secret proving a first-party marker really is our own Vercel SSR. Same value the Cloudflare worker gets. Empty leaves every first-party request in the unverified (monthly-metered) class, which is degraded but never throttled."
  type        = string
  sensitive   = true
  default     = ""
}

variable "rate_limit_ssr_bypass_user_agent" {
  description = "User-agent marker identifying our own SSR. Must match the edge worker's binding."
  type        = string
  default     = "shorted-web-ssr"
}

variable "rate_limit_ssr_bypass_header_name" {
  description = "Header carrying the SSR bypass secret. Must match the edge worker's binding."
  type        = string
  default     = "x-shorted-ssr-bypass"
}

# Internal tier grants. Comma-separated user ids that receive `internal_tier`
# regardless of any api_subscriptions row, so an operator can use their own API
# without a hand-written Stripe subscription that the next webhook overwrites.
# Empty by default: configuring nothing grants nothing.
variable "internal_tier_user_ids" {
  description = "Comma-separated user ids granted the internal API tier"
  type        = string
  default     = ""
}

variable "internal_tier" {
  description = "Tier granted to internal_tier_user_ids (free, pro, enterprise)"
  type        = string
  default     = "enterprise"
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
