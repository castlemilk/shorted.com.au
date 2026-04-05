/**
 * Cloudflare Edge Module — Variables
 *
 * Manages DNS, edge caching worker, WAF, rate limiting, and TLS
 * for shorted.com.au behind Cloudflare.
 */

# ---- Cloudflare Account ----

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for shorted.com.au"
  type        = string
}

variable "domain" {
  description = "Primary domain behind Cloudflare (e.g. api.shorted.com.au)"
  type        = string
}

variable "environment" {
  description = "Environment label (dev/prod)"
  type        = string
  default     = "dev"
}

# ---- Origin ----

variable "shorts_api_origin" {
  description = "Origin URL for the Shorts API Cloud Run service (e.g. https://shorts-xxxxx.australia-southeast2.run.app)"
  type        = string
}

variable "market_data_origin" {
  description = "Origin URL for the Market Data API Cloud Run service"
  type        = string
  default     = ""
}

variable "frontend_origin" {
  description = "Origin URL for the Vercel frontend (e.g. https://shorted.com.au)"
  type        = string
  default     = "https://shorted.com.au"
}

# ---- Edge Worker ----

variable "worker_name" {
  description = "Name of the Cloudflare Worker"
  type        = string
  default     = "shorted-edge-cache"
}

variable "cache_ttl_seconds" {
  description = "Default edge cache TTL in seconds for cacheable API responses"
  type        = number
  default     = 30
}

variable "top_shorts_cache_ttl" {
  description = "Cache TTL for top shorts / treemap (infrequently changing, high-traffic)"
  type        = number
  default     = 60
}

variable "stock_data_cache_ttl" {
  description = "Cache TTL for individual stock data pages"
  type        = number
  default     = 30
}

variable "news_cache_ttl" {
  description = "Cache TTL for news articles"
  type        = number
  default     = 120
}

variable "static_cache_ttl" {
  description = "Cache TTL for static assets (images, fonts, JS/CSS)"
  type        = number
  default     = 86400
}

# ---- Rate Limiting ----

variable "rate_limit_enabled" {
  description = "Enable Cloudflare rate limiting rules"
  type        = bool
  default     = true
}

variable "api_rate_limit_requests" {
  description = "Max requests per minute for API endpoints (anonymous)"
  type        = number
  default     = 60
}

variable "api_rate_limit_period" {
  description = "Rate limit period in seconds (Cloudflare free plan requires 10)"
  type        = number
  default     = 10
}

variable "search_rate_limit_requests" {
  description = "Max search requests per minute per IP"
  type        = number
  default     = 20
}

# ---- WAF / Security ----

variable "waf_enabled" {
  description = "Enable Cloudflare WAF managed rules"
  type        = bool
  default     = true
}

variable "bot_protection_enabled" {
  description = "Enable Cloudflare bot management"
  type        = bool
  default     = true
}

variable "blocked_countries" {
  description = "List of country codes to block at the edge (ISO 3166-1 alpha-2)"
  type        = list(string)
  default     = []
}

# ---- Purge Secret ----

variable "cache_purge_secret" {
  description = "Shared secret for the /api/cache/purge endpoint"
  type        = string
  sensitive   = true
  default     = ""
}

# ---- DNS Control ----

variable "chat_service_origin" {
  description = "Origin URL for Chat Service Cloud Run"
  type        = string
  default     = ""
}

variable "vercel_cname" {
  description = "CNAME target for Vercel-hosted frontend"
  type        = string
  default     = "cname.vercel-dns.com"
}

variable "create_frontend_records" {
  description = "Create CNAME records for shorted.com.au and www.shorted.com.au"
  type        = bool
  default     = true
}

variable "create_api_record" {
  description = "Create CNAME record for api.shorted.com.au"
  type        = bool
  default     = true
}
