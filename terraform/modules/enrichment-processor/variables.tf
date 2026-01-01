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

