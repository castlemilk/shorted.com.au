variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run service"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}

variable "image_url" {
  description = "Docker image URL for the Cloud Run service"
  type        = string
}

variable "min_instances" {
  description = "Minimum number of Cloud Run instances"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 10
}

variable "database_url_secret_name" {
  description = "Name of the Secret Manager secret containing PostgreSQL DATABASE_URL"
  type        = string
  default     = "DATABASE_URL"
}

variable "allow_unauthenticated" {
  description = "Allow unauthenticated access to the CMS"
  type        = bool
  default     = true
}

variable "additional_env_vars" {
  description = "Additional environment variables to set"
  type        = map(string)
  default     = {}
}
