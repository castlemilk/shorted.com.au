variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
}

variable "pr_number" {
  description = "Pull request number"
  type        = string
}

variable "shorts_api_image" {
  description = "Docker image URL for shorts API service"
  type        = string
}

variable "market_data_image" {
  description = "Docker image URL for market data service"
  type        = string
}

variable "shorts_service_account" {
  description = "Service account email for shorts service"
  type        = string
}

variable "postgres_address" {
  description = "PostgreSQL server address"
  type        = string
}

variable "postgres_database" {
  description = "PostgreSQL database name"
  type        = string
}

variable "postgres_username" {
  description = "PostgreSQL username"
  type        = string
}

variable "postgres_password_secret_name" {
  description = "Name of the secret containing PostgreSQL password"
  type        = string
  default     = "APP_STORE_POSTGRES_PASSWORD"
}

