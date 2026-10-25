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

# The chat-model flag (Flaggr) and DeepSeek direct. Each is optional: an empty
# value adds no env var and no IAM grant, so an unset deploy keeps the revision's
# behaviour. The secrets must exist in Secret Manager before a name is set here,
# because Cloud Run refuses a revision that references a missing secret.
variable "flaggr_api_key_secret_name" {
  description = "Secret Manager secret holding the Flaggr project token. Empty turns the flag off."
  type        = string
  default     = ""
}

variable "flaggr_service_id" {
  description = "Flaggr service id that holds the chat-model flag. Empty turns the flag off."
  type        = string
  default     = ""
}

variable "flaggr_environment" {
  description = "Flaggr environment the flag is evaluated in (development, staging or production)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["development", "staging", "production"], var.flaggr_environment)
    error_message = "flaggr_environment must be development, staging or production."
  }
}

variable "deepseek_api_key_secret_name" {
  description = "Secret Manager secret holding the DeepSeek API key. Empty means no DeepSeek route."
  type        = string
  default     = ""
}

variable "openrouter_api_key_secret_name" {
  description = "Secret Manager secret holding the OpenRouter key for the chat route, exposed as OPENROUTER_API_KEY_CHAT. Empty means no OpenRouter route. Point it at the existing OPENROUTER_API_KEY secret; do not create a copy."
  type        = string
  default     = ""
}

variable "allow_prc_hosted_provider" {
  description = "Sets CHAT_ALLOW_PRC_HOSTED_PROVIDER to true or false. true lets production route to DeepSeek's PRC-hosted API; false keeps it refused. Set true only after the privacy review is complete."
  type        = bool
  default     = false
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
