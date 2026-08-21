variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "rosy-clover-477102-t5" # shorted-prod
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "australia-southeast2"
}

variable "stock_price_ingestion_image" {
  description = "Docker image URL for stock-price-ingestion service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/stock-price-ingestion:latest"
}

variable "short_data_sync_image" {
  description = "Docker image URL for short-data-sync job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/short-data-sync:latest"
}

variable "house_price_collector_image" {
  description = "Docker image URL for house-price-collector job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/house-price-collector:latest"
}

variable "house_price_collector_official_max_failures" {
  description = "Maximum official housing sources that may fail before the collector job exits non-zero"
  type        = number
  default     = 15

  validation {
    condition = (
      var.house_price_collector_official_max_failures >= 0 &&
      floor(var.house_price_collector_official_max_failures) == var.house_price_collector_official_max_failures
    )
    error_message = "house_price_collector_official_max_failures must be a non-negative integer."
  }
}

variable "shorted_jobs_image" {
  description = "Docker image URL for the consolidated `shorted <job>` batch binary (services/jobs)"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/shorted-jobs:latest"
}

variable "shorted_jobs_browser_image" {
  description = "Docker image URL for the browser (Debian + Chromium) variant of the consolidated `shorted <job>` binary (services/jobs/Dockerfile.browser) — used by `shorted discovery`"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/shorted-jobs-browser:latest"
}

variable "shorts_api_image" {
  description = "Docker image URL for shorts API service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/shorts:latest"
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

variable "asx_discovery_image" {
  description = "Docker image URL for asx-discovery job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/asx-discovery:latest"
}

variable "market_data_sync_image" {
  description = "Docker image URL for market-data-sync job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/market-data-sync:latest"
}

variable "enrichment_processor_image" {
  description = "Docker image URL for enrichment-processor service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/enrichment-processor:latest"
}

variable "image_tag" {
  description = "Image tag for forcing new Cloud Run revisions"
  type        = string
  default     = ""
}

variable "weekly_report_generator_image" {
  description = "Docker image URL for weekly-report-generator job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/weekly-report-generator:latest"
}

variable "market_data_image" {
  description = "Docker image URL for market-data API service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/market-data:latest"
}

variable "signals_collector_image" {
  description = "Docker image URL for the signals-collector job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/signals-collector:latest"
}

variable "report_extractor_image" {
  description = "Docker image URL shared by both report-extractor jobs"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/report-extractor:latest"
}

variable "chat_service_image" {
  description = "Docker image URL for chat-service"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/chat-service:latest"
}

# ---- Cloudflare Edge ----

variable "cloudflare_global_api_key" {
  description = "DEPRECATED: Cloudflare Global API Key. Kept for local-dev compatibility; CI uses cloudflare_api_token."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare scoped API Token (preferred). Provider auto-reads CLOUDFLARE_API_TOKEN env var; this variable lets callers pass it explicitly."
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
  description = "Cloudflare Zone ID for shorted.com.au (public DNS identifier, not a secret)."
  type        = string
  default     = "41b338d2d75853d7bedb9a93f1e824f1"
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

variable "rate_limit_testing_bypass_secret" {
  description = "Optional shared secret for trusted E2E/load-test traffic to bypass Cloudflare bot/browser challenges. Leave empty to disable."
  type        = string
  sensitive   = true
  default     = ""
}

variable "rate_limit_testing_bypass_header_name" {
  description = "Lowercase HTTP header carrying the Cloudflare trusted testing bypass secret."
  type        = string
  default     = "x-shorted-testing-bypass"
}

variable "rate_limit_testing_bypass_user_agent" {
  description = "User-agent substring required with the bypass secret for trusted E2E/load-test traffic."
  type        = string
  default     = "Shorted-E2E"
}

variable "rate_limit_ssr_bypass_secret" {
  description = "Optional shared secret for shorted.com.au's own Vercel SSR fetcher to bypass the Cloudflare zone rate limit. Server-held only. Leave empty to disable."
  type        = string
  sensitive   = true
  default     = ""
}

variable "rate_limit_ssr_bypass_header_name" {
  description = "Lowercase HTTP header carrying the first-party SSR bypass secret."
  type        = string
  default     = "x-shorted-ssr-bypass"
}

variable "rate_limit_ssr_bypass_user_agent" {
  description = "User-agent substring required with the SSR bypass secret for first-party Vercel SSR traffic."
  type        = string
  default     = "shorted-web-ssr"
}

variable "alert_recipient_email" {
  description = "Email for Cloud Run Job failure + ERROR-log/timeout alerts. Empty disables all alerting (the job_monitoring module becomes a no-op)."
  type        = string
  # Alerting is ON by default in prod. CI applies always pass
  # TF_VAR_alert_recipient_email from the ALERT_RECIPIENT_EMAIL GitHub secret
  # (currently ben.ebsworth@gmail.com — that value wins in CI), so the layer
  # has been armed there since June 2026. This non-empty default protects the
  # LOCAL apply path: with the old "" default, a hand apply without the env
  # var silently destroyed the channel + both policies. "" remains the
  # explicit kill switch.
  default = "ben@shorted.com.au"
}
