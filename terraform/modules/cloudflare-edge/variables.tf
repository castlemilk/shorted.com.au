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
  description = "Cache TTL for top shorts / treemap / weekly report (infrequently changing, high-traffic). ASIC data changes daily, so 5min is safe."
  type        = number
  default     = 300
}

variable "stock_data_cache_ttl" {
  description = "Cache TTL for individual stock data pages, search, director trades, dividends (3min default for balance of freshness vs origin load)"
  type        = number
  default     = 180
}

variable "news_cache_ttl" {
  description = "Cache TTL for news and announcements"
  type        = number
  default     = 300
}

variable "static_cache_ttl" {
  description = "Cache TTL for static assets (images, fonts, JS/CSS)"
  type        = number
  default     = 86400
}

variable "cache_rules_enabled" {
  description = "Enable edge cache rules for frontend static assets (evaluated before Worker)"
  type        = bool
  default     = true
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
  description = "Deprecated — unused (Cloudflare Free has only 1 rule limit). Kept for compatibility."
  type        = number
  default     = 20
}

variable "frontend_domain" {
  description = "Frontend domain behind Cloudflare (e.g. shorted.com.au)"
  type        = string
  default     = ""
}

variable "frontend_rate_limit_requests" {
  description = "Max requests per period (unified limit for API + frontend)"
  type        = number
  default     = 60
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

# ---- KV Edge Cache ----

variable "prewarm_enabled" {
  description = "Enable KV-based edge cache pre-warming (runs daily after ASIC data sync)"
  type        = bool
  default     = true
}

variable "prewarm_secret" {
  description = "Shared secret for the pre-warm worker HTTP endpoint (used by Cloudflare cron)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "prewarm_cron_schedule" {
  description = "Cron schedule for pre-warm trigger (12 PM UTC = 2h after 10 AM UTC daily sync, safe buffer for 30-min sync deadline)"
  type        = string
  default     = "0 12 * * *"
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

# ---- AI crawler policy ----

variable "manage_ai_crawler_settings" {
  description = <<-EOT
    Manage the zone's AI Crawl Control via Terraform (cloudflare_bot_management).
    Requires the Cloudflare API token to have the "Zone → Bot Management → Edit"
    permission — the default token scoped for Workers/DNS/cache returns 403.
    Flip to true after re-scoping CLOUDFLARE_API_TOKEN.
  EOT
  type        = bool
  default     = false
}

variable "ai_bots_protection" {
  description = <<-EOT
    Cloudflare AI bots protection. "disabled" = allow AI crawlers (GPTBot,
    ClaudeBot, CCBot…), which is deliberate: the site's discovery strategy
    depends on AI crawler access (llms.txt, Content-Signals in robots.txt,
    MCP server). "block" also injects a managed robots.txt with Disallow
    rules ABOVE our own — which silently defeated the AI-allow policy until
    it was switched off in June 2026. Keep "disabled" unless that strategy
    changes.
  EOT
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["block", "disabled", "only_on_ad_pages"], var.ai_bots_protection)
    error_message = "ai_bots_protection must be one of: block, disabled, only_on_ad_pages."
  }
}

variable "markdown_for_agents" {
  description = "Cloudflare Markdown for Agents (content_converter zone setting). Serves markdown to Accept: text/markdown clients. Requires Pro+ plan."
  type        = string
  default     = "on"

  validation {
    condition     = contains(["on", "off"], var.markdown_for_agents)
    error_message = "markdown_for_agents must be \"on\" or \"off\"."
  }
}

# ---- DNS email-security records (SPF / DMARC) ----

variable "dns_security_enabled" {
  description = "Create the SPF and DMARC TXT records for the apex domain. The domain uses Google Workspace for mail; these records harden it against spoofing and improve deliverability."
  type        = bool
  default     = true
}

variable "spf_record" {
  description = <<-EOT
    SPF policy published as an apex TXT record. Default authorises Google
    Workspace only and soft-fails everything else (~all) — the safe first
    policy. Tighten to -all once DMARC aggregate reports confirm no
    legitimate senders are missed. Add include: mechanisms here if a
    transactional-email provider (e.g. Resend, SendGrid) is later wired up.
  EOT
  type        = string
  default     = "v=spf1 include:_spf.google.com ~all"
}

variable "dmarc_record" {
  description = <<-EOT
    DMARC policy published as a _dmarc TXT record. Default is p=none
    (monitor only — does not affect delivery) with aggregate reports sent to
    dmarc-reports@shorted.com.au. The rua mailbox must exist in Google
    Workspace (a mailbox or a Group) or reports bounce. Move to p=quarantine
    then p=reject after observing reports.
  EOT
  type        = string
  default     = "v=DMARC1; p=none; rua=mailto:dmarc-reports@shorted.com.au; ruf=mailto:dmarc-reports@shorted.com.au; fo=1; adkim=r; aspf=r"
}

# ---- DNSSEC ----

variable "manage_dnssec" {
  description = <<-EOT
    Enable DNSSEC signing on the Cloudflare zone. Creating the resource makes
    Cloudflare sign the zone and exposes the DS record (see the dnssec_ds_record
    output). DNSSEC only becomes active once that DS record is published at the
    domain registrar — a manual, outward-facing step. Enabling signing alone is
    safe and breaks nothing until the DS is published.
  EOT
  type        = bool
  default     = true
}
