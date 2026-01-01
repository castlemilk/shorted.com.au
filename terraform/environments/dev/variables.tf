variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "shorted-dev-aba5688f"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "australia-southeast2"
}

variable "stock_price_ingestion_image" {
  description = "Docker image URL for stock-price-ingestion service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/stock-price-ingestion:latest"
}

variable "short_data_sync_image" {
  description = "Docker image URL for short-data-sync job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/short-data-sync:latest"
}

variable "shorts_api_image" {
  description = "Docker image URL for shorts API service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts:latest"
}

variable "cms_image" {
  description = "Docker image URL for CMS service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/cms:latest"
}

variable "postgres_address" {
  description = "PostgreSQL server address"
  type        = string
  default     = "aws-0-ap-southeast-2.pooler.supabase.com:5432"
}

variable "postgres_database" {
  description = "PostgreSQL database name"
  type        = string
  default     = "postgres"
}

variable "postgres_username" {
  description = "PostgreSQL username"
  type        = string
  default     = "postgres.xivfykscsdagwsreyqgf"
}

variable "cms_mongodb_secret_name" {
  description = "Name of the Secret Manager secret containing MongoDB URI for CMS"
  type        = string
  default     = ""
}

variable "enrichment_processor_image" {
  description = "Docker image URL for enrichment-processor job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/enrichment-processor:latest"
}

