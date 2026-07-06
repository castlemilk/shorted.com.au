terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19, < 6"
    }
  }
}

# =============================================================================
# Locals — derive hostnames from origin URLs
# =============================================================================

locals {
  shorts_api_hostname            = try(regex("^https?://([^/]+)", var.shorts_api_origin)[0], "")
  chat_service_hostname          = try(var.chat_service_origin != "" ? regex("^https?://([^/]+)", var.chat_service_origin)[0] : "", "")
  market_data_hostname           = try(var.market_data_origin != "" ? regex("^https?://([^/]+)", var.market_data_origin)[0] : "", "")
  api_rate_limit_host_expression = "http.host eq \"api.shorted.com.au\""
  testing_bypass_expression      = var.rate_limit_testing_bypass_secret != "" ? "(http.user_agent contains \"${var.rate_limit_testing_bypass_user_agent}\" and any(http.request.headers[\"${var.rate_limit_testing_bypass_header_name}\"][*] eq \"${var.rate_limit_testing_bypass_secret}\"))" : "false"
  # Cloudflare's basic rate-limit phase does not allow request header or
  # user-agent fields in rate-limit expressions. Trusted tests bypass that
  # phase via the custom skip ruleset below, while normal API traffic remains
  # limited by host.
  api_rate_limit_expression = local.api_rate_limit_host_expression
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




# =============================================================================
# Worker script — edge caching for Shorted multi-origin architecture
# =============================================================================

resource "cloudflare_workers_script" "edge_cache" {
  account_id = data.cloudflare_zone.shorted.account.id
  content    = file("${path.module}/../../../services/edge-worker/worker.js")









  script_name = var.worker_name
  bindings = concat([
    {
      type = "plain_text"
      name = "SHORTS_API_ORIGIN"
      text = var.shorts_api_origin
      }, {
      type = "plain_text"
      name = "CACHE_TTL_DEFAULT"
      text = tostring(var.cache_ttl_seconds)
      }, {
      type = "plain_text"
      name = "CACHE_TTL_TOP_SHORTS"
      text = tostring(var.top_shorts_cache_ttl)
      }, {
      type = "plain_text"
      name = "CACHE_TTL_STOCK_DATA"
      text = tostring(var.stock_data_cache_ttl)
      }, {
      type = "plain_text"
      name = "CACHE_TTL_NEWS"
      text = tostring(var.news_cache_ttl)
      }, {
      type = "plain_text"
      name = "EDGE_ANALYTICS_SAMPLE_RATE"
      text = tostring(var.edge_analytics_sample_rate)
      }, {
      type = "plain_text"
      name = "CACHE_PURGE_SECRET"
      text = var.cache_purge_secret
      }, {
      type         = "kv_namespace"
      name         = "EDGE_KV"
      namespace_id = cloudflare_workers_kv_namespace.edge_cache.id
    }
    ], var.chat_service_origin != "" ? [{
      type = "plain_text"
      name = "CHAT_SERVICE_ORIGIN"
      text = var.chat_service_origin
      }] : [], var.market_data_origin != "" ? [{
      type = "plain_text"
      name = "MARKET_DATA_ORIGIN"
      text = var.market_data_origin
  }] : [])
  main_module = "worker.js"
}

# =============================================================================
# Worker routes — attach worker to both API and frontend domains
# The worker checks hostname internally and routes accordingly:
#   - api.shorted.com.au/* -> Shorts API origin (with edge caching)
#   - shorted.com.au/*     -> Vercel frontend (DDoS + WAF + real client IP forwarded)
# =============================================================================

resource "cloudflare_workers_route" "api" {
  zone_id = var.cloudflare_zone_id
  pattern = "api.shorted.com.au/*"
  script  = cloudflare_workers_script.edge_cache.id
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
  account_id = data.cloudflare_zone.shorted.account.id
  title      = "shorted-edge-cache-${var.environment}"
}

# =============================================================================
# Pre-warm Worker — populates KV after daily ASIC data sync
# Runs once per day via Cloudflare cron trigger (11 AM UTC, 1h after sync).
# Fetches hot endpoints from origin and writes to KV for global access.
# =============================================================================

resource "cloudflare_workers_script" "prewarm" {
  count = var.prewarm_enabled ? 1 : 0

  account_id = data.cloudflare_zone.shorted.account.id
  content    = file("${path.module}/../../../services/edge-worker/prewarm.js")




  script_name = "${var.worker_name}-prewarm"
  bindings = concat([
    {
      type = "plain_text"
      name = "SHORTS_API_ORIGIN"
      text = var.shorts_api_origin
      }, {
      type = "plain_text"
      name = "PREWARM_SECRET"
      text = var.prewarm_secret
      }, {
      type         = "kv_namespace"
      name         = "SHORTED_EDGE_CACHE"
      namespace_id = cloudflare_workers_kv_namespace.edge_cache.id
    }
    ], var.market_data_origin != "" ? [{
      type = "plain_text"
      name = "MARKET_DATA_ORIGIN"
      text = var.market_data_origin
  }] : [])
  main_module = "worker.js"
}

# =============================================================================
# Cron Trigger — runs pre-warm worker once per day after data sync
# Sync runs at 10 AM UTC (daily_sync job); pre-warm runs at 12 PM UTC (2h later,
# well after the 30-min sync deadline). Also callable via HTTP for immediate pre-warm.
# =============================================================================

resource "cloudflare_workers_cron_trigger" "prewarm" {
  count = var.prewarm_enabled ? 1 : 0

  account_id  = data.cloudflare_zone.shorted.account.id
  script_name = cloudflare_workers_script.prewarm[0].script_name
  schedules   = [{ cron = var.prewarm_cron_schedule }]
}

# =============================================================================
# Cache Rules — edge caching for frontend static assets
# These are evaluated BEFORE the Worker, so static assets are served directly
# from Cloudflare's edge cache without invoking the Worker script.
# Order matters: more specific rules must come first.
# =============================================================================

resource "cloudflare_ruleset" "cache_rules" {
  count = var.cache_rules_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-cache-rules"
  description = "Edge cache rules for frontend static assets"
  kind        = "zone"
  phase       = "http_request_cache_settings"






  rules = [
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and http.request.uri.path contains \"/_next/static/\""
      description = "Cache Next.js static assets (JS/CSS/WASM) at edge"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 31536000
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = 31536000
            },
            {
              status_code_range = {
                from = 300
              }
              value = 0
            }
          ]
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        cache_key = {
          cache_by_device_type  = false
          cache_deception_armor = true
        }
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and http.request.uri.path contains \"/_next/data/\""
      description = "Cache Next.js page data (RSC/JSON) at edge"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 31536000
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = 31536000
            },
            {
              status_code_range = {
                from = 300
              }
              value = 0
            }
          ]
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        cache_key = {
          cache_by_device_type  = false
          cache_deception_armor = true
        }
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and (http.request.uri.path contains \".png\" or http.request.uri.path contains \".jpg\" or http.request.uri.path contains \".jpeg\" or http.request.uri.path contains \".gif\" or http.request.uri.path contains \".svg\" or http.request.uri.path contains \".webp\" or http.request.uri.path contains \".avif\" or http.request.uri.path contains \".ico\")"
      description = "Cache static image assets at edge"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 31536000
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = 31536000
            },
            {
              status_code_range = {
                from = 300
              }
              value = 0
            }
          ]
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        cache_key = {
          cache_by_device_type  = false
          cache_deception_armor = true
        }
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and (http.request.uri.path contains \".woff\" or http.request.uri.path contains \".woff2\" or http.request.uri.path contains \".ttf\" or http.request.uri.path contains \".eot\")"
      description = "Cache static font assets at edge"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 31536000
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = 31536000
            },
            {
              status_code_range = {
                from = 300
              }
              value = 0
            }
          ]
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        cache_key = {
          cache_by_device_type  = false
          cache_deception_armor = true
        }
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and starts_with(http.request.uri.path, \"/shorts/\") and not http.request.uri.path contains \"/news\" and not http.request.uri.path contains \"/community\" and not http.request.uri.path contains \".\""
      description = "Cache public stock detail HTML pages at edge"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = var.stock_page_cache_ttl
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = var.stock_page_cache_ttl
            },
            {
              status_code_range = {
                from = 300
              }
              value = 0
            }
          ]
        }
        browser_ttl = {
          mode = "respect_origin"
        }
        cache_key = {
          cache_by_device_type  = false
          cache_deception_armor = true
        }
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and (http.request.uri.path eq \"/\" or not http.request.uri.path contains \".\")"
      description = "Bypass edge cache for HTML pages — let Vercel handle it"
      enabled     = true
      action_parameters = {
        cache = false
      }
    },
    {
      action      = "set_cache_settings"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and http.request.uri.path contains \"/api/\""
      description = "Bypass edge cache for frontend API routes"
      enabled     = true
      action_parameters = {
        cache = false
      }
    }
  ]
}

# =============================================================================
# Response Header Transforms — prevent browser-retained asset error responses
# =============================================================================

resource "cloudflare_ruleset" "response_header_transforms" {
  count = var.cache_rules_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-response-header-transforms"
  description = "Response header transforms for frontend cache safety"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [
    {
      ref         = "no_store_missing_next_static_assets"
      action      = "rewrite"
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and http.request.uri.path contains \"/_next/static/\" and http.response.code ge 400"
      description = "Prevent browser caching of missing Next.js static assets"
      enabled     = true
      action_parameters = {
        headers = {
          "Cache-Control" = {
            operation = "set"
            value     = "no-store, max-age=0, must-revalidate"
          }
        }
      }
    }
  ]
}

# =============================================================================
# =============================================================================
# Custom security skips — app API/RPC endpoints
# =============================================================================
# Cloudflare Super Bot Fight Mode and Browser Integrity/Security Level checks can
# managed-challenge non-browser service traffic before the Worker or Vercel
# rewrites see it. These paths are app-owned API surfaces; keep managed WAF
# intact, and let only trusted E2E/load-test probes skip rate limiting.

resource "cloudflare_ruleset" "app_api_security_skip" {
  count = var.waf_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-app-api-security-skip"
  description = "Skip bot/security challenges for app API and RPC paths"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      action      = "skip"
      expression  = <<-EOT
        (
          http.host eq "${var.domain}"
          or (
            (http.host eq "shorted.com.au" or http.host eq "www.shorted.com.au")
            and (
              starts_with(http.request.uri.path, "/shorts.v1alpha1.")
              or starts_with(http.request.uri.path, "/marketdata.v1.")
              or starts_with(http.request.uri.path, "/chat.v1.")
              or starts_with(http.request.uri.path, "/register.v1.")
              or starts_with(http.request.uri.path, "/api/auth/")
              or starts_with(http.request.uri.path, "/api/market-data/")
              or starts_with(http.request.uri.path, "/api/stocks/")
              or starts_with(http.request.uri.path, "/api/community/")
              or starts_with(http.request.uri.path, "/api/algolia/")
            )
          )
        )
      EOT
      description = "Allow app API/RPC traffic through SBFM, BIC, and Security Level checks"
      enabled     = true
      action_parameters = {
        phases   = ["http_request_sbfm"]
        products = ["bic", "securityLevel"]
      }
      logging = {
        enabled = false
      }
    },
    {
      action      = "skip"
      expression  = <<-EOT
        (
          http.host eq "${var.domain}"
          or http.host eq "shorted.com.au"
          or http.host eq "www.shorted.com.au"
        )
        and ${local.testing_bypass_expression}
      EOT
      description = "Allow trusted E2E/load-test traffic through SBFM, BIC, Security Level, and rate-limit checks"
      enabled     = true
      action_parameters = {
        phases   = ["http_request_sbfm", "http_ratelimit"]
        products = ["bic", "securityLevel"]
      }
      logging = {
        enabled = false
      }
    }
  ]
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



  rules = [
    {
      action      = "skip"
      expression  = "(cf.client.bot)"
      description = "Skip WAF for known bots"
      enabled     = true
      action_parameters = {
        phases = ["http_request_firewall_managed"]
      }
      logging = {
        enabled = false
      }
    },
    {
      action      = "skip"
      expression  = "(http.host eq \"${var.domain}\")"
      description = "Bypass WAF for API domain — backend has own auth"
      enabled     = true
      action_parameters = {
        phases = ["http_request_firewall_managed"]
      }
      logging = {
        enabled = false
      }
    },
    {
      action      = "execute"
      expression  = "(http.host ne \"${var.domain}\")"
      description = "Execute Cloudflare Managed Free Ruleset for frontend domain"
      enabled     = true
      action_parameters = {
        id = "77454fe2d30c4220b5701f6fdfb893ba"
        overrides = {
          enabled = true
        }
      }
    }
  ]
}

# =============================================================================
# Rate limiting — API and search endpoints
# =============================================================================

resource "cloudflare_ruleset" "rate_limit_api" {
  count = var.rate_limit_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "shorted-rate-limit"
  description = "Rate limiting for Shorted API host"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      action      = "block"
      description = "Rate limit — API host usage"
      enabled     = true
      expression  = local.api_rate_limit_expression
      action_parameters = {
        response = {
          status_code  = 429
          content_type = "application/json"
          content      = jsonencode({ error = "Too Many Requests", message = "Rate limit exceeded. Please slow down." })
        }
      }
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = var.api_rate_limit_period
        requests_per_period = var.api_rate_limit_requests
        mitigation_timeout  = var.api_rate_limit_period
      }
    }
  ]
}

# =============================================================================
# AI Crawl Control — bot management
# =============================================================================
# Codifies the zone's AI crawler policy so a dashboard toggle can't silently
# reintroduce the managed robots.txt block (which serves "Disallow: /" to
# GPTBot/ClaudeBot/CCBot above our own allow rules — observed June 2026).
#
# NOTE: provider v4 (last release 4.52.7) does not expose
# is_robots_txt_managed or the content_converter ("Markdown for Agents")
# zone setting — both are provider v5 / newer API surface. Markdown for
# Agents is additionally unavailable on the Free plan (content_converter is
# editable: false). Revisit both on a provider v5 migration or plan upgrade.

resource "cloudflare_bot_management" "ai_crawl_control" {
  count = var.manage_ai_crawler_settings ? 1 : 0

  zone_id            = var.cloudflare_zone_id
  ai_bots_protection = var.ai_bots_protection
  # Our app serves robots.txt (Content-Signals + explicit AI-allow groups);
  # Cloudflare's managed robots.txt would prepend conflicting Disallow rules.
  is_robots_txt_managed = false
}


# =============================================================================
# Tiered Cache — Smart Topology
# =============================================================================
# Cache misses at AU edge colos pull from the nearest upper-tier datacenter
# to the origin instead of all independently hitting Vercel/Cloud Run —
# higher effective HIT ratio and lower origin load.


# =============================================================================
# Markdown for Agents (content_converter zone setting)
# =============================================================================
# Serves a markdown rendition of HTML pages to clients sending
# Accept: text/markdown — token-efficient pages for AI agents. Pro-plan
# feature; native cloudflare_zone_setting resource since provider v5.

resource "cloudflare_zone_setting" "markdown_for_agents" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "content_converter"
  value      = var.markdown_for_agents
}

# =============================================================================
# Cloudflare Web Analytics / RUM
# =============================================================================
# Enables Cloudflare's automatic RUM beacon injection for proxied hostnames.
# Keep the app-managed manual beacon disabled unless a manual token is confirmed
# for the exact browser hostname; cross-origin manual beacons fail noisily when
# the Web Analytics site token does not match.

resource "cloudflare_zone_setting" "web_analytics_rum" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "rum"
  value      = var.web_analytics_rum
}

resource "cloudflare_dns_record" "frontend" {
  count = var.create_frontend_records ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "@"
  content = "76.76.21.21" # Vercel anycast IP for apex domains
  type    = "A"
  proxied = true
  ttl     = 1

  # Cloudflare normalises "@" to the zone name when storing root records,
  # which causes a perpetual diff. Ignore the name attribute so an existing
  # imported record matches the @ shorthand in this config.
  lifecycle {
    ignore_changes = [name]
  }
}

moved {
  from = cloudflare_record.frontend
  to   = cloudflare_dns_record.frontend
}

resource "cloudflare_dns_record" "www" {
  count = var.create_frontend_records ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "www"
  content = var.vercel_cname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

moved {
  from = cloudflare_record.www
  to   = cloudflare_dns_record.www
}

resource "cloudflare_dns_record" "api" {
  count = var.create_api_record ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "api"
  content = local.shorts_api_hostname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

moved {
  from = cloudflare_record.api
  to   = cloudflare_dns_record.api
}

# =============================================================================
# Email-security DNS records — SPF + DMARC
# =============================================================================
# The domain receives/sends mail via Google Workspace (MX -> smtp.google.com)
# but had no SPF or DMARC, leaving it open to spoofing and hurting deliverability.
# These coexist with the existing google-site-verification TXT record (multiple
# TXT records per name are valid). NOTE: cloudflare provider v5 has an
# undocumented TXT-quoting quirk (provider issues #5351/#6354) — if `plan` shows
# a perpetual diff, wrap content in escaped quotes: "\"v=spf1 ...\"".

resource "cloudflare_dns_record" "spf" {
  count = var.dns_security_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "TXT"
  content = var.spf_record
  ttl     = 1 # automatic; TXT records can't be proxied
  comment = "SPF — managed by Terraform (cloudflare-edge module)"

  # Cloudflare normalises "@" to the zone name on read (perpetual-diff guard,
  # same as the apex A record above).
  lifecycle {
    ignore_changes = [name]
  }
}

resource "cloudflare_dns_record" "dmarc" {
  count = var.dns_security_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = var.dmarc_record
  ttl     = 1
  comment = "DMARC — managed by Terraform (cloudflare-edge module)"
}

# =============================================================================
# DNSSEC — zone signing
# =============================================================================
# Creating this resource makes Cloudflare sign the zone. DNSSEC is not actually
# enforced until the DS record (dnssec_ds_record output) is published at the
# .com.au registrar — a manual step. Signing alone changes nothing for
# resolvers, so this is safe to apply ahead of the registrar update.

resource "cloudflare_zone_dnssec" "shorted" {
  count = var.manage_dnssec ? 1 : 0

  zone_id = var.cloudflare_zone_id
}

resource "cloudflare_zone_setting" "security_always_use_https" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_automatic_https_rewrites" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "automatic_https_rewrites"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_early_hints" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "early_hints"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_http3" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "http3"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_min_tls_version" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "security_polish" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "polish"
  value      = "lossless"
}

resource "cloudflare_zone_setting" "security_speed_brain" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "speed_brain"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_ssl" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "ssl"
  value      = "full"
}

resource "cloudflare_zone_setting" "security_webp" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "webp"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_zero_rtt" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "0rtt"
  value      = "on"
}

# NOTE: Crawler Hints (IndexNow for Bing/Yandex) is NOT settable via
# cloudflare_zone_setting in provider v5 — the API rejects a PATCH with
# setting_id="crawlhints" ("failed to make http request"), which broke
# terraform apply. Enable it via the Cloudflare dashboard instead
# (Caching → Configuration → Crawler Hints). Google does not consume IndexNow,
# so this only affects Bing/Yandex; for Google we rely on the sitemap + GSC.

resource "cloudflare_tiered_cache" "smart" {
  zone_id = var.cloudflare_zone_id
  value   = "on"
}

resource "cloudflare_argo_tiered_caching" "smart" {
  zone_id = var.cloudflare_zone_id
  value   = "on"
}
