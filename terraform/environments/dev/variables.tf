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

variable "postgres_address" {
  description = "PostgreSQL server address (using transaction pooler port 6543)"
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

variable "enrichment_processor_image" {
  description = "Docker image URL for enrichment-processor job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/enrichment-processor:latest"
}

variable "asx_discovery_image" {
  description = "Docker image URL for asx-discovery job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/asx-discovery:latest"
}

variable "market_data_sync_image" {
  description = "Docker image URL for market-data-sync job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/market-data-sync:latest"
}

variable "market_data_image" {
  description = "Docker image URL for market-data API service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/market-data:latest"
}

variable "weekly_report_generator_image" {
  description = "Docker image URL for weekly-report-generator job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/weekly-report-generator:latest"
}

variable "image_tag" {
  description = "Image tag for forcing new Cloud Run revisions"
  type        = string
  default     = ""
}

variable "news_aggregator_image" {
  description = "Docker image URL for news-aggregator job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/news-aggregator:latest"
}

variable "asx_announcement_crawler_image" {
  description = "Docker image URL for asx-announcement-crawler job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/asx-announcement-crawler:latest"
}

variable "chat_service_image" {
  description = "Docker image URL for chat-service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/chat-service:latest"
}

variable "grafana_url" {
  description = "Grafana Cloud instance URL"
  type        = string
  default     = "https://skunkworq.grafana.net"
}

variable "grafana_auth" {
  description = "Grafana service account token"
  type        = string
  sensitive   = true
  default     = "" # NOTE: Grafana dashboards not yet configured — set real token to enable
}

# ---- Cloudflare Edge ----

variable "cloudflare_global_api_key" {
  description = "DEPRECATED: Cloudflare Global API Key. Kept for local-dev compatibility; CI uses cloudflare_api_token."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare scoped API Token (preferred). The provider auto-reads CLOUDFLARE_API_TOKEN env var; this var lets callers pass it explicitly when needed."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_email" {
  description = "Cloudflare account email."
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for shorted.com.au."
  type        = string
}

variable "chat_service_origin" {
  description = "Chat Service Cloud Run origin URL"
  type        = string
  default     = ""
}

variable "cache_purge_secret" {
  description = "Shared secret for edge cache purge endpoint"
  type        = string
  sensitive   = true
  default     = ""
}

variable "gemini_secret_exists" {
  description = "Whether the Gemini API secret exists in Secret Manager"
  type        = bool
  default     = true
}

variable "anthropic_secret_exists" {
  description = "Whether ANTHROPIC_API_KEY secret exists in Secret Manager"
  type        = bool
  default     = true
}

variable "newsroom_job_image" {
  description = "Docker image URL for the newsroom daily take-writer job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/take-writer:latest"
}
