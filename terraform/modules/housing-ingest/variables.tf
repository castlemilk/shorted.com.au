variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for the ingest Cloud Run service (rigs reach its run.app URL)"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Image for the ingest service. The shorts API image: the same binary, run with SHORTS_SERVE_MODE=ingest."
  type        = string
}

variable "max_instances" {
  description = "Maximum ingest instances. Capped at 2: each instance holds db_max_conns connections, so the ceiling is 2 * 4 = 8 of Supabase's 60."
  type        = number
  default     = 2

  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 2 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances must be an integer from 1 to 2 (see the connection budget in main.tf)."
  }
}

variable "db_max_conns" {
  description = "HOUSING_INGEST_DB_MAX_CONNS: the ingest pool's size per instance."
  type        = number
  default     = 4

  validation {
    condition     = var.db_max_conns >= 1 && var.db_max_conns <= 4 && floor(var.db_max_conns) == var.db_max_conns
    error_message = "db_max_conns must be an integer from 1 to 4."
  }
}

variable "ingest_org" {
  description = <<-EOT
    HOUSING_INGEST_ORG: the org claim BrandBrain puts on workload tokens, which the verifier
    checks. Empty by default, so the service is inert. Set in environments/prod at cutover.
  EOT
  type        = string
  default     = ""
}

variable "ingest_allow_subjects" {
  description = <<-EOT
    HOUSING_INGEST_ALLOW_SUBJECTS: comma-separated rig subjects ("rig:<id>") that may push.
    Empty by default, so no rig is accepted. Each rig is added by a reviewed change here, and
    also by a housing_ingest_rigs row (docs/feature/housing/operations.md, "Server-side crawl jobs").
  EOT
  type        = string
  default     = ""
}

variable "ingest_deny_kids" {
  description = <<-EOT
    HOUSING_INGEST_DENY_KIDS: comma-separated signing key IDs (kid values) the ingest rejects
    even when the signature verifies. Emergency kill list. Empty by default, so no kid is
    denied. Entries are the exact kid strings from the token header, with no spaces and no
    empty entries (the verifier refuses an empty entry, and the service then answers every
    rig with Unavailable). Set it in environments/prod/variables.tf or a tfvars file and
    apply, so the next apply keeps it.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^$|^[A-Za-z0-9._:-]+(,[A-Za-z0-9._:-]+)*$", var.ingest_deny_kids))
    error_message = "ingest_deny_kids must be empty or a comma-separated list of kid values with no spaces and no empty entries."
  }
}

variable "dispatch_ttl" {
  description = "HOUSING_INGEST_DISPATCH_TTL. Keep equal to the house-price-collector module's ingest_dispatch_ttl."
  type        = string
  default     = "72h"

  validation {
    condition     = can(regex("^[0-9]+(h|m|s)$", var.dispatch_ttl))
    error_message = "dispatch_ttl must be a Go duration in whole hours, minutes or seconds, such as 72h."
  }
}
