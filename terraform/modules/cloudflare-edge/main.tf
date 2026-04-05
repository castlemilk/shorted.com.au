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
  shorts_api_hostname    = regex("^https?://([^/]+)", var.shorts_api_origin)[0]
  chat_service_hostname  = var.chat_service_origin != "" ? regex("^https?://([^/]+)", var.chat_service_origin)[0] : ""
  market_data_hostname   = var.market_data_origin != "" ? regex("^https?://([^/]+)", var.market_data_origin)[0] : ""
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
}

# =============================================================================
# Worker route — attach worker to api.shorted.com.au/*
# =============================================================================

resource "cloudflare_workers_route" "api" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "${var.domain}/*"
  script_name = cloudflare_workers_script.edge_cache.name
}

# =============================================================================
# Zone settings — TLS configuration
# =============================================================================

resource "cloudflare_zone_settings_override" "tls" {
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
  name        = "shorted-rate-limit-api"
  description = "Rate limiting for Shorted API"
  kind        = "zone"
  phase       = "http_ratelimit"

  # Combined rate limit: stricter for search, general for API
  rules {
    action      = "block"
    description = "Rate limit — ${var.api_rate_limit_requests} req/${var.api_rate_limit_period}s general, ${var.search_rate_limit_requests} req/${var.api_rate_limit_period}s search"
    enabled     = true
    expression  = "(http.host eq \"${var.domain}\" and http.request.uri.path contains \"Search\")"

    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = var.api_rate_limit_period
      requests_per_period = var.search_rate_limit_requests
      mitigation_timeout  = var.api_rate_limit_period
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
