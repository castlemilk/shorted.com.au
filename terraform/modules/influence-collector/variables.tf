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
  description = "Docker image URL for the influence collector Cloud Run job"
  type        = string
}

# ---------------------------------------------------------------------------
# APH register-of-interests crawl. Opt-in, because the crawl is operator-run and
# an environment that never runs it needs no bucket.
# ---------------------------------------------------------------------------

variable "manage_register_bucket" {
  description = <<-EOT
    Create the private bucket that holds fetched APH register PDFs.

    Leave false in environments that do not run the register crawl. The collector
    falls back to a local directory (REGISTER_CACHE_DIR) when REGISTER_BUCKET is
    unset, so an unmanaged environment degrades to local-only rather than failing.
  EOT
  type        = bool
  default     = false
}

variable "register_bucket_name" {
  description = "Override the register bucket name. Defaults to <project_id>-register-interests."
  type        = string
  default     = ""
}

variable "register_bucket_prefix" {
  description = "Object prefix within the register bucket."
  type        = string
  default     = "aph"
}

variable "register_retention_days" {
  description = <<-EOT
    Days before a fetched register PDF is deleted.

    This is a LICENCE control, not a cost control. Parliamentary material may be
    reproduced as extracted facts with attribution, not rehosted as a mirror;
    expiring the source documents is what keeps "we do not maintain a mirror"
    true in fact. Extraction artifacts (register_extractions) are content-
    addressed and survive, so a re-parse never needs a re-fetch.
  EOT
  type        = number
  default     = 400
}

variable "reader_service_accounts" {
  description = <<-EOT
    Service accounts granted objectViewer on the register bucket — in practice
    the report-extractor job, which parses the PDFs.

    Granted HERE rather than from the consuming module: binding IAM on a bucket
    owned by another module is what produced the cross-project getIamPolicy 403
    documented in terraform/modules/report-extractor/main.tf.
  EOT
  type        = list(string)
  default     = []
}

variable "register_fetch_delay_ms" {
  description = <<-EOT
    Delay between APH requests, in milliseconds.

    Politeness, not throughput. The fetch is deliberately serial on one
    connection; 1500ms over ~800 documents is ~20 minutes, which is invisible to
    aph.gov.au. Do not lower this to speed up a backfill.
  EOT
  type        = number
  default     = 1500
}
