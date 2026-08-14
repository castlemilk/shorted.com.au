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
