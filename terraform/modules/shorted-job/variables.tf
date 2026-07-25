variable "name" {
  description = "Cloud Run Job name (also the scheduler + service-account name prefix). Must be 6-24 chars so the '-sched' SA account_id stays within the 30-char limit."
  type        = string

  validation {
    condition     = length(var.name) >= 6 && length(var.name) <= 24
    error_message = "name must be 6-24 characters (the scheduler SA appends '-sched' and service-account IDs are capped at 30)."
  }
}

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

variable "description" {
  description = "Human-readable description used on the scheduler job"
  type        = string
  default     = ""
}

variable "image_url" {
  description = "Docker image URL for the consolidated shorted jobs binary"
  type        = string
}

variable "args" {
  description = "Container args — the `shorted <subcommand> [flags]` invocation, e.g. [\"economy\", \"-mode\", \"all\"]"
  type        = list(string)
}

variable "env" {
  description = "Plain environment variables (name => value)"
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Secret-backed environment variables (env var name => Secret Manager secret id). The job SA is granted secretAccessor on each."
  type        = map(string)
  default     = {}
}

variable "schedule" {
  description = "Cloud Scheduler cron expression (UTC)"
  type        = string
}

variable "paused" {
  description = "Pause the Cloud Scheduler job (the Cloud Run job stays deployed and manually executable)"
  type        = bool
  default     = false
}

variable "timeout_seconds" {
  description = "Per-task timeout for the Cloud Run job, in seconds"
  type        = number
  default     = 1800
}

variable "cpu" {
  description = "CPU limit for the job container (e.g. \"1\", \"2\")"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit for the job container (e.g. \"512Mi\", \"1Gi\")"
  type        = string
  default     = "512Mi"
}

variable "max_retries" {
  description = "Cloud Run Job task max_retries"
  type        = number
  default     = 2
}

variable "scheduler_attempt_deadline" {
  description = "Cloud Scheduler attempt deadline (the :run call returns immediately; this is not the job runtime)"
  type        = string
  default     = "1800s"
}
