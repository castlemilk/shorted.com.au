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
  description = "Docker image URL for the chat service"
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
  default     = 5
}

variable "max_instance_request_concurrency" {
  description = "Maximum concurrent requests per chat-service instance"
  type        = number
  default     = 8
}

variable "otel_endpoint" {
  description = "OpenTelemetry OTLP endpoint for traces and metrics"
  type        = string
  default     = "https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp"
}

variable "gemini_max_output_tokens" {
  description = "Maximum output tokens per Gemini chat model call"
  type        = number
  default     = 1024
}

variable "gemini_secret_name" {
  description = "Secret Manager secret name containing this service's Gemini API key"
  type        = string
  default     = "GEMINI_API_KEY"
}

variable "internal_service_secret_name" {
  description = "Secret Manager secret name containing the internal service auth secret"
  type        = string
  default     = "INTERNAL_SERVICE_SECRET"
}

variable "chat_max_input_chars" {
  description = "Maximum user message length accepted by chat"
  type        = number
  default     = 2000
}

variable "chat_history_limit" {
  description = "Maximum recent chat messages included in the Gemini prompt"
  type        = number
  default     = 20
}

variable "chat_max_messages_per_conversation" {
  description = "Maximum retained messages per chat conversation"
  type        = number
  default     = 100
}

variable "postgres_address" {
  description = "PostgreSQL server address (transaction pooler port 6543)"
  type        = string
  default     = "aws-0-ap-southeast-2.pooler.supabase.com:6543"
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

variable "shorts_api_url" {
  description = "URL of the Shorts API service for tool execution"
  type        = string
}
