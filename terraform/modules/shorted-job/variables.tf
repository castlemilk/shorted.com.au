variable "name" {
  description = "Cloud Run Job name (also the scheduler + service-account name prefix). Capped at 30 chars by the job SA's account_id; a SCHEDULED job is capped at 24 because its invoker SA appends '-sched' (enforced by a precondition on that resource, not here, so unscheduled jobs may use the full 30)."
  type        = string

  validation {
    condition     = length(var.name) >= 6 && length(var.name) <= 30
    error_message = "name must be 6-30 characters (service-account IDs are capped at 30)."
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
  description = "Cloud Scheduler cron expression (UTC). Empty creates NO scheduler (and no invoker SA) — for jobs whose only caller is external, e.g. the economy freshness sentinel executed by a GitHub workflow."
  type        = string
  default     = ""
}

variable "paused" {
  description = "Pause the Cloud Scheduler job (the Cloud Run job stays deployed and manually executable)"
  type        = bool
  default     = false
}

# Extra schedules for jobs whose ONE Cloud Run Job is triggered on several crons
# with different modes (the news-aggregator shape: 1 job, 5 schedulers, 4 of
# them setting RUN_MODE + friends via container_overrides in the scheduler HTTP
# body). Each entry becomes an additional google_cloud_scheduler_job named
# "<name>-<name_suffix>"; the primary `schedule` above is unaffected, so
# single-schedule instantiations keep exactly the resources they already have.
#
# Override semantics (Cloud Run `:run` overrides payload — same mechanism the
# old news-aggregator / weekly-report-generator schedulers use):
#   - env_override  MERGES into the container env by name (unset vars keep the
#     job's configured value).
#   - args_override REPLACES the container args wholesale, so it must repeat the
#     `shorted <subcommand>` prefix.
# An entry with neither override posts no body at all (a plain :run).
variable "schedules" {
  description = "Additional Cloud Scheduler triggers for the same job, each optionally overriding args/env via the Cloud Run overrides payload"
  type = list(object({
    name_suffix      = string
    cron             = string
    description      = optional(string, "")
    paused           = optional(bool)
    attempt_deadline = optional(string)
    args_override    = optional(list(string))
    env_override     = optional(map(string))
  }))
  default = []

  validation {
    condition     = length(distinct([for s in var.schedules : s.name_suffix])) == length(var.schedules)
    error_message = "schedules[].name_suffix must be unique (it keys the resource and names the scheduler job)."
  }

  validation {
    condition     = alltrue([for s in var.schedules : length("${s.name_suffix}") > 0])
    error_message = "schedules[].name_suffix must not be empty."
  }
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
