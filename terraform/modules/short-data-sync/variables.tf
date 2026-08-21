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

variable "image_url" {
  description = "LEGACY Docker image URL for the Cloud Run job (the services/daily-sync Python image). Only used when use_go_monolith = false; keep it wired so the one-variable rollback has a currently-built image to fall back to."
  type        = string
}

# ---------------------------------------------------------------------------
# Jobs-monolith cutover. ONE toggle selects image + command + args + sizing;
# see main.tf's header for the rollback procedure and why they are coupled.
# ---------------------------------------------------------------------------

variable "use_go_monolith" {
  description = <<-EOT
    Run the consolidated Go binary (`shorted short-data-sync`, services/jobs)
    instead of the legacy services/daily-sync Python image.

    true  (default): image = shorted_jobs_image, command = ["/shorted"],
                     args = ["short-data-sync"], timeout 3600s, max_retries 1.
    false          : image = image_url with its own ENTRYPOINT/CMD
                     (python comprehensive_daily_sync.py), timeout 28800s,
                     max_retries 5 — i.e. the exact pre-cutover job.

    Flipping this single variable is the whole rollback. Do NOT add a
    separate image override: an image-only rollback that left `/shorted` in
    place would crash-loop.
  EOT
  type        = bool
  default     = true
}

variable "shorted_jobs_image" {
  description = "Docker image URL for the consolidated `shorted <job>` binary (services/jobs). Required when use_go_monolith = true."
  type        = string
  default     = ""
}

variable "sync_days_shorts" {
  description = "SYNC_DAYS_SHORTS — how many days of ASIC files to look back when the shorts table is empty. 7 matches both the legacy image's ENV default and the Go job's compiled default."
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
    mounted into the job + granted to its SA. Defaults to false because the
    secret is not yet provisioned in prod; main.py skips revalidation gracefully
    when it is unset (pages self-heal on the ISR TTL). Set true once the secret
    is created AND the matching value is set in the frontend (Vercel) env to
    enable event-driven cache invalidation.
  EOT
  type        = bool
  default     = false
}

