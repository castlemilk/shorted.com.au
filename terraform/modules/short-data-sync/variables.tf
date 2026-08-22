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
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

# ---------------------------------------------------------------------------
# This job is monolith-only. There is no legacy image input and no mode
# toggle: image + command + args + sizing are fixed together in main.tf's
# locals. See main.tf's header for the (git revert) rollback procedure.
# ---------------------------------------------------------------------------

variable "shorted_jobs_image" {
  description = "Docker image URL for the consolidated `shorted <job>` binary (services/jobs). Required — a plan-time precondition rejects an empty value."
  type        = string
  default     = ""
}

variable "sync_days_shorts" {
  description = "SYNC_DAYS_SHORTS — how many days of ASIC files to look back when the shorts table is empty. 7 is the Go job's compiled default."
  type        = number
  default     = 7

  validation {
    condition     = var.sync_days_shorts >= 1 && floor(var.sync_days_shorts) == var.sync_days_shorts
    error_message = "sync_days_shorts must be a positive integer."
  }
}

variable "bucket_name" {
  description = "Name for the GCS bucket storing short selling data (must be globally unique)"
  type        = string
  default     = "" # If empty, defaults to 'shorted-short-selling-data'
}

variable "revalidation_url" {
  description = "Frontend on-demand revalidation endpoint, pinged after a sync writes new data to bust cached SSR pages."
  type        = string
  default     = "https://shorted.com.au/api/revalidate"
}

variable "manage_revalidation_secret" {
  description = <<-EOT
    Whether the REVALIDATION_SECRET Secret Manager secret exists and should be
    mounted into the job + granted to its SA. Defaults to false for
    environments where the secret is not provisioned; the job skips
    revalidation gracefully when it is unset (pages self-heal on the ISR TTL).
    Set true once the secret is created AND the matching value is set in the
    frontend (Vercel) env to enable event-driven cache invalidation.
  EOT
  type        = bool
  default     = false
}

