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
  description = "GCP region for Cloud Scheduler (only available in southeast1)"
  type        = string
  default     = "australia-southeast1"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the house-price collector Cloud Run job"
  type        = string
}

variable "official_max_failures" {
  description = "Maximum official sources that may fail before the collector exits non-zero; 15 means only a total failure of the current 16 sources is fatal"
  type        = number
  default     = 15

  validation {
    condition = (
      var.official_max_failures >= 0 &&
      floor(var.official_max_failures) == var.official_max_failures
    )
    error_message = "official_max_failures must be a non-negative integer."
  }
}

variable "revalidation_url" {
  description = <<-EOT
    Frontend on-demand revalidation endpoint, pinged after a crawl-driven MV
    refresh writes new housing data to bust the cached SSR pages (/price-drops,
    /housing). Mirrors the short-data-sync default (the canonical host works for
    the Cloud Run job because terraform/modules/cloudflare-edge skips
    /api/revalidate from the managed challenge). Residential-Mac agent runs
    instead read REVALIDATION_URL from ~/.shorted-housing-crawl.env and are
    documented to use the Vercel origin.
  EOT
  type        = string
  default     = "https://shorted.com.au/api/revalidate"
}

variable "manage_revalidation_secret" {
  description = <<-EOT
    Whether the REVALIDATION_SECRET Secret Manager secret exists and should be
    mounted into the job + granted to its SA. Defaults to false because the
    secret may not be provisioned in every env; the collector skips revalidation
    gracefully when it is unset (housing pages self-heal on the ISR TTL). Set
    true once the secret is created AND the matching value is set in the frontend
    (Vercel) env to enable event-driven cache invalidation.
  EOT
  type        = bool
  default     = false
}

variable "monthly_scheduler_paused" {
  description = "Pause the monthly official-ingest trigger. Set true once the job runs as a Kubernetes CronJob on omega instead (deploy/kubernetes/jobs; driven by local.jobs_on_vke in environments/prod/main.tf). The Cloud Run job itself stays deployed for admin Run-now and manual executions."
  type        = bool
  default     = false
}

variable "drop_index_scheduler_paused" {
  description = "Pause the daily drop-index trigger. Set true once the job runs as a Kubernetes CronJob on omega instead (deploy/kubernetes/jobs; driven by local.jobs_on_vke in environments/prod/main.tf). The Cloud Run job itself stays deployed for admin Run-now and manual executions."
  type        = bool
  default     = false
}

variable "server_schedules_paused" {
  description = <<-EOT
    Pause the server-side crawl schedules (S-SRV): server-enqueue (delta and full),
    crawl-finalize, freshness and property-resolve. Defaults to TRUE, so every new
    schedule is created paused and nothing runs until cutover. Cutover is a reviewed
    change to this value in environments/prod, then docs/feature/housing/operations.md
    "Server-side crawl jobs". Do not change the default to false.
  EOT
  type        = bool
  default     = true
}

variable "brandbrain_url" {
  description = "BrandBrain base URL for the server-side enqueue (BRANDBRAIN_AGENT_URL). Must be the BrandBrain environment that allowlists this job's service account."
  type        = string
  default     = "https://api.brandbrain.dev"
}

variable "brandbrain_idtoken_audience" {
  description = "Audience of the Google ID token the server-side enqueue presents to BrandBrain (BRANDBRAIN_IDTOKEN_AUDIENCE). BrandBrain verifies this exact value."
  type        = string
  default     = "https://api.brandbrain.dev"
}

variable "ingest_dispatch_ttl" {
  description = <<-EOT
    crawl_dispatch.expires_at = enqueue time + this (HOUSING_INGEST_DISPATCH_TTL). The
    ingest refuses a sweep for a job past its expiry. Keep equal to the housing-ingest
    module's dispatch_ttl, which the ingest reads back through expires_at.
  EOT
  type        = string
  default     = "72h"

  validation {
    condition     = can(regex("^[0-9]+(h|m|s)$", var.ingest_dispatch_ttl))
    error_message = "ingest_dispatch_ttl must be a Go duration in whole hours, minutes or seconds, such as 72h."
  }
}
