terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# =============================================================================
# Locals — derive hostnames from origin URLs
# =============================================================================

locals {
  shorts_api_hostname    = try(regex("^https?://([^/]+)", var.shorts_api_origin)[0], "")
  chat_service_hostname  = try(var.chat_service_origin != "" ? regex("^https?://([^/]+)", var.chat_service_origin)[0] : "", "")
  market_data_hostname   = try(var.market_data_origin != "" ? regex("^https?://([^/]+)", var.market_data_origin)[0] : "", "")
}

# =============================================================================
# Data source — Cloudflare zone
# =============================================================================

data "cloudflare_zone" "shorted" {
  zone_id = var.cloudflare_zone_id
}

# =============================================================================
# DNS — CNAME records for frontend (Vercel) and API
# =============================================================================

resource "cloudflare_record" "frontend" {
  count = var.create_frontend_records ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "@"
  content = "76.76.21.21" # Vercel anycast IP for apex domains
  type    = "A"
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "www" {
  count = var.create_frontend_records ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "www"
  content = var.vercel_cname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "api" {
  count = var.create_api_record ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "api"
  content = local.shorts_api_hostname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# =============================================================================
# Worker script — edge caching for Shorted multi-origin architecture
# =============================================================================

resource "cloudflare_workers_script" "edge_cache" {
  account_id = data.cloudflare_zone.shorted.account_id
  name       = var.worker_name
  content    = file("${path.module}/../../../services/edge-worker/worker.js")
  module     = true

  plain_text_binding {
    name = "SHORTS_API_ORIGIN"
    text = var.shorts_api_origin
  }

  dynamic "plain_text_binding" {
    for_each = var.chat_service_origin != "" ? [1] : []
    content {
      name = "CHAT_SERVICE_ORIGIN"
      text = var.chat_service_origin
    }
  }

  dynamic "plain_text_binding" {
    for_each = var.market_data_origin != "" ? [1] : []
    content {
      name = "MARKET_DATA_ORIGIN"
      text = var.market_data_origin
    }
  }

  plain_text_binding {
    name = "CACHE_TTL_DEFAULT"
    text = tostring(var.cache_ttl_seconds)
  }

  plain_text_binding {
    name = "CACHE_TTL_TOP_SHORTS"
    text = tostring(var.top_shorts_cache_ttl)
  }

  plain_text_binding {
    name = "CACHE_TTL_STOCK_DATA"
    text = tostring(var.stock_data_cache_ttl)
  }

  plain_text_binding {
    name = "CACHE_TTL_NEWS"
    text = tostring(var.news_cache_ttl)
  }

  plain_text_binding {
    name = "CACHE_PURGE_SECRET"
    text = var.cache_purge_secret
  }

  kv_namespace_binding {
    name = "EDGE_KV"
    namespace_id = cloudflare_workers_kv_namespace.edge_cache.id
  }
}

# =============================================================================
# Worker routes — attach worker to both API and frontend domains
# The worker checks hostname internally and routes accordingly:
#   - api.shorted.com.au/* -> Shorts API origin (with edge caching)
#   - shorted.com.au/*     -> Vercel frontend (DDoS + WAF + real client IP forwarded)
# =============================================================================

resource "cloudflare_workers_route" "api" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "api.shorted.com.au/*"
  script_name = cloudflare_workers_script.edge_cache.name
}

# NOTE: shorted.com.au/* worker route is managed outside Terraform due to
# cloudflare/provider#4395 (import returns empty ID). The route already
# exists in Cloudflare and forwards frontend traffic through the worker.

# =============================================================================
# KV Namespace — globally distributed cache for pre-warmed responses
# Single namespace shared by edge_cache (reads) and prewarm (writes).
# ASIC short selling data changes daily; KV entries expire after 24 hours.
# =============================================================================

resource "cloudflare_workers_kv_namespace" "edge_cache" {
  account_id = data.cloudflare_zone.shorted.account_id
  title      = "shorted-edge-cache-${var.environment}"
}

# =============================================================================
# Pre-warm Worker — populates KV after daily ASIC data sync
# Runs once per day via Cloudflare cron trigger (11 AM UTC, 1h after sync).
# Fetches hot endpoints from origin and writes to KV for global access.
# =============================================================================

resource "cloudflare_workers_script" "prewarm" {
  count = var.prewarm_enabled ? 1 : 0

  account_id = data.cloudflare_zone.shorted.account_id
  name       = "${var.worker_name}-prewarm"
  content    = file("${path.module}/../../../services/edge-worker/prewarm.js")
  module     = true

  plain_text_binding {
    name = "SHORTS_API_ORIGIN"
    text = var.shorts_api_origin
  }

  dynamic "plain_text_binding" {
    for_each = var.market_data_origin != "" ? [1] : []
    content {
      name = "MARKET_DATA_ORIGIN"
      text = var.market_data_origin
    }
  }

  plain_text_binding {
    name = "PREWARM_SECRET"
    text = var.prewarm_secret
  }

  kv_namespace_binding {
    name        = "SHORTED_EDGE_CACHE"
    namespace_id = cloudflare_workers_kv_namespace.edge_cache.id
  }
}

# =============================================================================
# Cron Trigger — runs pre-warm worker once per day after data sync
# Sync runs at 10 AM UTC (daily_sync job); pre-warm runs at 12 PM UTC (2h later,
# well after the 30-min sync deadline). Also callable via HTTP for immediate pre-warm.
# =============================================================================

resource "cloudflare_workers_cron_trigger" "prewarm" {
  count = var.prewarm_enabled ? 1 : 0

  account_id  = data.cloudflare_zone.shorted.account_id
  script_name = cloudflare_workers_script.prewarm[0].name
  schedules   = [var.prewarm_cron_schedule]
}

# =============================================================================
# Zone settings — TLS configuration
# =============================================================================

resource "cloudflare_zone_settings_override" "security" {
  zone_id = var.cloudflare_zone_id

  settings {
    ssl                      = "full"
    always_use_https         = "on"
    min_tls_version          = "1.2"
    automatic_https_rewrites = "on"
  }
}

# =============================================================================
# WAF — Managed rules (Cloudflare OWASP Core Ruleset)
# =============================================================================

resource "cloudflare_ruleset" "waf_managed" {
  count = var.waf_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-waf-managed"
  description = "Shorted WAF managed rules"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  lifecycle {
    ignore_changes = [rules[0].logging]
  }

  # Skip WAF for known bots (Googlebot, etc.)
  rules {
    action      = "skip"
    expression  = "(cf.client.bot)"
    description = "Skip WAF for known bots"
    enabled     = true
    logging {
      enabled = false
    }
    action_parameters {
      phases = ["http_request_firewall_managed"]
    }
  }

  # Bypass WAF for API domain — the backend has its own authentication (Firebase/API keys).
  # The Managed Free Ruleset triggers false positives on legitimate server-to-server API calls
  # (e.g., Vercel server components calling api.shorted.com.au).
  rules {
    action      = "skip"
    expression  = "(http.host eq \"${var.domain}\")"
    description = "Bypass WAF for API domain — backend has own auth"
    enabled     = true
    logging {
      enabled = false
    }
    action_parameters {
      phases = ["http_request_firewall_managed"]
    }
  }

  # Execute Cloudflare Managed Free Ruleset for non-API domains (frontend zone)
  rules {
    action      = "execute"
    expression  = "(http.host ne \"${var.domain}\")"
    description = "Execute Cloudflare Managed Free Ruleset for frontend domain"
    enabled     = true
    action_parameters {
      id = "77454fe2d30c4220b5701f6fdfb893ba" # Cloudflare Managed Free Ruleset
      overrides {
        enabled = true
      }
    }
  }
}

# =============================================================================
# Rate limiting — API and search endpoints
# =============================================================================

resource "cloudflare_ruleset" "rate_limit_api" {
  count = var.rate_limit_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-rate-limit"
  description = "Rate limiting for Shorted platform (API + frontend)"
  kind        = "zone"
  phase       = "http_ratelimit"

  # Single unified rule: covers both api.shorted.com.au and shorted.com.au
  # Cloudflare Free plan allows only 1 rule per ruleset in http_ratelimit phase.
  # Key: http.x_forwarded_for gives the real client IP (vs ip.src which can be
  # shared across users behind carrier-grade NAT or corporate proxies).
  # Falls back gracefully: if XFF is missing, cf.colo.id groups by datacenter.
  rules {
    action      = "block"
    description = "Rate limit — 30 req/10s on API and frontend (anonymous)"
    enabled     = true
    expression  = "(http.host eq \"api.shorted.com.au\" or http.host eq \"shorted.com.au\")"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = 30
      mitigation_timeout  = 10
    }

    action_parameters {
      response {
        status_code  = 429
        content_type = "application/json"
        content      = jsonencode({
          error   = "Too Many Requests"
          message = "Rate limit exceeded. Please slow down."
        })
      }
    }
  }
}
