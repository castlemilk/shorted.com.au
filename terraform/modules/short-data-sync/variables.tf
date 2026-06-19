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
  description = "Docker image URL for the Cloud Run job"
  type        = string
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

