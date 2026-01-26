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
  description = "Docker image for ASX discovery"
  type        = string
}

variable "market_data_sync_image" {
  description = "Docker image for market data sync"
  type        = string
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
