variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "australia-southeast2"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "image_url" {
  description = "Docker image URL for the enrichment processor"
  type        = string
}

variable "postgres_address" {
  description = "PostgreSQL database address"
  type        = string
}

variable "postgres_database" {
  description = "PostgreSQL database name"
  type        = string
}

variable "postgres_username" {
  description = "PostgreSQL database username"
  type        = string
}

variable "topic_name_suffix" {
  description = "Optional suffix for Pub/Sub topic and subscription names (e.g., for preview environments)"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag for forcing new revisions"
  type        = string
  default     = ""
}
