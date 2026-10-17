variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run"
  type        = string
}

variable "scheduler_region" {
  description = "GCP region for Cloud Scheduler (only available in certain regions)"
  type        = string
  default     = "australia-southeast1"
}

variable "asx_discovery_image" {
  description = "Docker image for ASX discovery (legacy per-service image; superseded when asx_discovery_image_override is set)"
  type        = string
}

variable "market_data_sync_image" {
  description = "Docker image for market data sync (legacy per-service image; superseded when market_data_sync_image_override is set)"
  type        = string
}

# ---------------------------------------------------------------------------
# Jobs-monolith cutover (slice 3).
#
# These overrides repoint the EXISTING service/job resources at the
# `shorted-jobs` images without creating any new resource: the Cloud Run
# SERVICE gets a new revision, the Cloud Run JOB a new template. Nothing is
# destroyed, the scheduler URIs and service accounts are unchanged, and
# rollback is clearing the override (one variable, one apply) — plus, for the
# service, the immediate `gcloud run services update-traffic
# market-data-sync --to-revisions=<previous>=100` escape hatch.
# ---------------------------------------------------------------------------

variable "market_data_sync_image_override" {
  description = "When non-empty, the image the market-data-sync SERVICE runs instead of market_data_sync_image (used to run the consolidated `shorted market-data serve`)"
  type        = string
  default     = ""
}

variable "market_data_sync_command" {
  description = "Entrypoint override for the market-data-sync service container (empty = the image's own ENTRYPOINT)"
  type        = list(string)
  default     = []
}

variable "market_data_sync_args" {
  description = "Args override for the market-data-sync service container (empty = the image's own CMD)"
  type        = list(string)
  default     = []
}

variable "asx_discovery_image_override" {
  description = "When non-empty, the image the asx-discovery JOB runs instead of asx_discovery_image (used to run `shorted discovery` from the browser image)"
  type        = string
  default     = ""
}

variable "asx_discovery_command" {
  description = "Entrypoint override for the asx-discovery job container (empty = the image's own ENTRYPOINT)"
  type        = list(string)
  default     = []
}

variable "asx_discovery_args" {
  description = "Args override for the asx-discovery job container (empty = the image's own CMD)"
  type        = list(string)
  default     = []
}

variable "asx_discovery_download_dir" {
  description = "DOWNLOAD_DIR for the asx-discovery job (empty = unset, i.e. the image's own ENV default /tmp/asx-downloads — both images set it)"
  type        = string
  default     = ""
}

variable "bucket_name" {
  description = "GCS bucket for stock data"
  type        = string
}

variable "database_url_secret_id" {
  description = "Secret Manager secret ID for DATABASE_URL"
  type        = string
  default     = "DATABASE_URL"
}

variable "alpha_vantage_api_key_secret_id" {
  description = "Secret Manager secret ID for ALPHA_VANTAGE_API_KEY"
  type        = string
  default     = "ALPHA_VANTAGE_API_KEY"
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "min_instances" {
  description = "Minimum number of instances for market data sync service"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of instances for market data sync service"
  type        = number
  default     = 10
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}

variable "market_data_sync_scheduler_paused" {
  description = "Pause the weekday market-data-sync-daily scheduler (POST /api/sync/all). The service stays deployed and callable; the daily price sweep runs as the shorted-price-sync Cloud Run Job instead."
  type        = bool
  default     = false
}

variable "asx_discovery_scheduler_paused" {
  description = "Pause the asx-discovery weekly trigger. Set true once the job runs as a Kubernetes CronJob on omega instead (deploy/kubernetes/jobs; driven by local.jobs_on_vke in environments/prod/main.tf). The Cloud Run job itself stays deployed for admin Run-now and manual executions."
  type        = bool
  default     = false
}
