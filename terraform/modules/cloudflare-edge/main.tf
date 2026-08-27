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
  # First-party SSR bypass — same shape as the testing bypass (never UA-only):
  # our own Vercel SSR fetcher must present BOTH the shorted-web-ssr UA marker
  # AND the exact secret header. Empty secret keeps this a literal "false", so
  # the rule can never match.
  ssr_bypass_expression = var.rate_limit_ssr_bypass_secret != "" ? "(http.user_agent contains \"${var.rate_limit_ssr_bypass_user_agent}\" and any(http.request.headers[\"${var.rate_limit_ssr_bypass_header_name}\"][*] eq \"${var.rate_limit_ssr_bypass_secret}\"))" : "false"
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

  # Workers Logs. WITHOUT THIS, EVERY console.log THE WORKER EMITS IS DISCARDED.
  # Discovered 2026-08-23 via the Workers Observability API: the script had
  # `observability: null`, `logpush: false`, `tail_consumers: []` — so the
  # edge_request stream AND every event added for rate limiting, origin errors,
  # config snapshots and KV failures went nowhere. They were only visible in a
  # live `wrangler tail`, which meant 7,045 self-inflicted 429s went unnoticed
  # for days and the documented operator queries could never have returned data.
  #
  # head_sampling_rate MUST STAY 1. It is HEAD-based: Cloudflare drops the whole
  # request context, so anything below 1 silently discards a proportion of the
  # events the worker deliberately emits at 100% (every limited decision, every
  # origin error). Volume is already controlled in the worker itself —
  # EDGE_ANALYTICS_SAMPLE_RATE and friends decide what is emitted; this setting
  # only decides whether what IS emitted gets kept. Sampling twice, at two
  # layers, with one of them invisible, is how you get a log stream nobody can
  # reason about.
  observability = {
    enabled            = true
    head_sampling_rate = 1
  }









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
      name = "CACHE_TTL_PUBLIC_DAILY"
      text = tostring(var.public_daily_cache_ttl)
      }, {
      type = "plain_text"
      name = "CACHE_TTL_PUBLIC_STALE"
      text = tostring(var.public_stale_cache_ttl)
      }, {
      type = "plain_text"
      name = "EDGE_ANALYTICS_SAMPLE_RATE"
      text = tostring(var.edge_analytics_sample_rate)
      }, {
      # ALLOWED-arm sample rate for edge_rate_limit only. -1 means "inherit
      # EDGE_ANALYTICS_SAMPLE_RATE", which the worker expresses as an empty
      # string (an absent/blank var falls back). LIMITED decisions are emitted
      # at 100% regardless and no var can change that.
      type = "plain_text"
      name = "EDGE_RATE_LIMIT_SAMPLE_RATE"
      text = var.edge_rate_limit_sample_rate < 0 ? "" : tostring(var.edge_rate_limit_sample_rate)
      }, {
      # Same -1-means-inherit convention as above. See variables.tf.
      type = "plain_text"
      name = "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"
      text = var.edge_upstream_latency_sample_rate < 0 ? "" : tostring(var.edge_upstream_latency_sample_rate)
      }, {
      # Samples ONLY the routine (accepted SSR) arm. The testing class and every
      # rejected outcome are emitted at 100% in worker.js and no var can change
      # that — they are the leaked-secret and probe detectors.
      type = "plain_text"
      name = "EDGE_BYPASS_SAMPLE_RATE"
      text = var.edge_bypass_sample_rate < 0 ? "" : tostring(var.edge_bypass_sample_rate)
      }, {
      # THE DEPLOY FEEDBACK LOOP. A short hash of the worker.js content this
      # apply is uploading, echoed back by the worker in its once-per-isolate
      # edge_config event. "Did the config I just deployed actually reach the
      # worker" becomes: compare this to the deploy_id in the log, instead of
      # reading Terraform state or the Cloudflare API and hoping they agree.
      #
      # Derived from the same file() call that produces `content`, so it cannot
      # drift from what is deployed.
      type = "plain_text"
      name = "EDGE_DEPLOY_ID"
      text = substr(sha256(file("${path.module}/../../../services/edge-worker/worker.js")), 0, 12)
      }, {
      type = "plain_text"
      name = "CACHE_PURGE_SECRET"
      text = var.cache_purge_secret
      }, {
      type = "plain_text"
      name = "EDGE_RATE_LIMIT_ENABLED"
      text = var.edge_rate_limit_enabled ? "true" : "false"
      }, {
      type = "plain_text"
      name = "EDGE_RATE_LIMIT_TRUST_CRAWLER_UA"
      text = var.edge_rate_limit_trust_crawler_ua ? "true" : "false"
      }, {
      # The bucket matrix, mirrored into worker vars so worker.js never has to
      # hardcode a production number. Keep in sync with RATE_LIMIT_BUCKETS in
      # services/edge-worker/worker.js (its compiled-in defaults are the
      # fail-safe used only when a var is missing).
      type = "plain_text"
      name = "RATE_LIMIT_KEY_BURST"
      text = tostring(var.edge_rate_limit_key_burst_requests)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_KEY_LIMIT"
      text = tostring(var.edge_rate_limit_key_requests_per_minute)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_ANON_BURST"
      text = tostring(var.edge_rate_limit_anon_burst_requests)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_ANON_LIMIT"
      text = tostring(var.edge_rate_limit_anon_requests_per_minute)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_FIRST_PARTY_BURST"
      text = tostring(var.edge_rate_limit_first_party_burst_requests)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_BROWSER_ANON_BURST"
      text = tostring(var.edge_rate_limit_browser_anon_burst_requests)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_BROWSER_ANON_LIMIT"
      text = tostring(var.edge_rate_limit_browser_anon_requests_per_minute)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_BROWSER_AUTH_BURST"
      text = tostring(var.edge_rate_limit_browser_auth_burst_requests)
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_BROWSER_AUTH_LIMIT"
      text = tostring(var.edge_rate_limit_browser_auth_requests_per_minute)
      }, {
      # Bypass config mirrors the zone skip rules. The worker requires BOTH the
      # UA marker and the exact secret, exactly like the Terraform expressions
      # in locals above — never the UA alone.
      type = "plain_text"
      name = "RATE_LIMIT_TESTING_BYPASS_USER_AGENT"
      text = var.rate_limit_testing_bypass_user_agent
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_TESTING_BYPASS_HEADER_NAME"
      text = var.rate_limit_testing_bypass_header_name
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_SSR_BYPASS_USER_AGENT"
      text = var.rate_limit_ssr_bypass_user_agent
      }, {
      type = "plain_text"
      name = "RATE_LIMIT_SSR_BYPASS_HEADER_NAME"
      text = var.rate_limit_ssr_bypass_header_name
      }, {
      # Rate limiting bindings — Cloudflare Workers Rate Limiting API.
      #
      # `period` is a HARD ENUM: 10 or 60 seconds, nothing else. So "burst" and
      # "sustained" cannot be one binding — every traffic class that needs both
      # windows needs TWO bindings, which is why there are nine of them.
      #
      # Counters are per-colo and eventually consistent by design; these are
      # origin-protection ceilings, not an accounting system. The monthly quota
      # stays app-side, and per-TIER per-minute enforcement lives in-process in
      # services/pkg/ratelimit — this layer is deliberately tier-blind.
      #
      # Two bindings that share a namespace_id share counters, EVEN ACROSS
      # WORKERS on the account, so every ID here must stay unique.
      #
      # --- api.shorted.com.au, authenticated (keyed by SHA-256 of the token) ---
      # The documented paid API tier is per-minute UNLIMITED, so this cannot be
      # a tier ceiling: 600/60s (10 req/s sustained) leaves a legitimate bulk
      # pull completely unimpeded and only catches a runaway or a leaked key.
      type         = "ratelimit"
      name         = "API_KEY_BURST_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_key_burst_namespace_id
      simple = {
        limit  = var.edge_rate_limit_key_burst_requests
        period = 10
      }
      }, {
      type         = "ratelimit"
      name         = "API_KEY_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_key_namespace_id
      simple = {
        limit  = var.edge_rate_limit_key_requests_per_minute
        period = 60
      }
      }, {
      # --- api.shorted.com.au, anonymous (keyed by real client IP) ---
      # The one class where the ceiling equals a documented tier: an
      # unauthenticated caller hitting the public API host directly has no
      # entitlement beyond the anonymous 30/min. First-party rewrite traffic
      # never lands here — it carries the SSR marker and gets its own bucket.
      type         = "ratelimit"
      name         = "ANON_BURST_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_anon_burst_namespace_id
      simple = {
        limit  = var.edge_rate_limit_anon_burst_requests
        period = 10
      }
      }, {
      type         = "ratelimit"
      name         = "ANON_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_anon_namespace_id
      simple = {
        limit  = var.edge_rate_limit_anon_requests_per_minute
        period = 60
      }
      }, {
      # --- api.shorted.com.au, first-party (Vercel SSR + rewrite proxy) ---
      # A runaway detector, not a tier. Keyed by Vercel egress IP so one looping
      # instance is contained without penalising the others. Burst-only: a
      # sustained window would be measuring normal fan-out, not a fault.
      type         = "ratelimit"
      name         = "FIRST_PARTY_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_first_party_namespace_id
      simple = {
        limit  = var.edge_rate_limit_first_party_burst_requests
        period = 10
      }
      }, {
      # --- shorted.com.au, anonymous browser (keyed by REAL client IP) ---
      # Measured on prod with Playwright, logged out, counting only limitable
      # (non-HTML, non-/api/auth) requests: /shorts/BHP = 9 per page load,
      # / = 6, /top = 2. Worst realistic human burst is 3-4 stock pages in 10s
      # = 27-36 requests; hardest minute is 10-15 pages = 90-135. 100/10s and
      # 600/60s are ~3x and ~4.4x those, so a real reader can never hit them.
      type         = "ratelimit"
      name         = "BROWSER_ANON_BURST_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_browser_anon_burst_namespace_id
      simple = {
        limit  = var.edge_rate_limit_browser_anon_burst_requests
        period = 10
      }
      }, {
      type         = "ratelimit"
      name         = "BROWSER_ANON_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_browser_anon_namespace_id
      simple = {
        limit  = var.edge_rate_limit_browser_anon_requests_per_minute
        period = 60
      }
      }, {
      # --- shorted.com.au, signed-in browser (keyed by session-cookie hash) ---
      # Keyed on the session rather than the IP so an office, university or
      # CGNAT egress cannot collapse every colleague into one bucket. Double
      # the anonymous allowance.
      type         = "ratelimit"
      name         = "BROWSER_AUTH_BURST_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_browser_auth_burst_namespace_id
      simple = {
        limit  = var.edge_rate_limit_browser_auth_burst_requests
        period = 10
      }
      }, {
      type         = "ratelimit"
      name         = "BROWSER_AUTH_RATE_LIMITER"
      namespace_id = var.edge_rate_limit_browser_auth_namespace_id
      simple = {
        limit  = var.edge_rate_limit_browser_auth_requests_per_minute
        period = 60
      }
      }, {
      type         = "kv_namespace"
      name         = "EDGE_KV"
      namespace_id = cloudflare_workers_kv_namespace.edge_cache.id
    }
    ], var.rate_limit_testing_bypass_secret != "" ? [{
      type = "secret_text"
      name = "RATE_LIMIT_TESTING_BYPASS_SECRET"
      text = var.rate_limit_testing_bypass_secret
      }] : [], var.rate_limit_ssr_bypass_secret != "" ? [{
      type = "secret_text"
      name = "RATE_LIMIT_SSR_BYPASS_SECRET"
      text = var.rate_limit_ssr_bypass_secret
      }] : [], var.edge_rate_limit_analytics_dataset != "" ? [{
      # Workers Analytics Engine — OFF unless a dataset name is supplied, and
      # the worker no-ops when the binding is absent. Gives the rate limit
      # decision stream a SQL endpoint ("429s by bucket over time") instead of
      # requiring a Logpush pipeline to answer an aggregate question.
      type    = "analytics_engine"
      name    = "RATE_LIMIT_ANALYTICS"
      dataset = var.edge_rate_limit_analytics_dataset
      }] : [], var.edge_events_analytics_dataset != "" ? [{
      # Second Analytics Engine dataset — origin errors + upstream latency.
      # Separate from RATE_LIMIT_ANALYTICS because AE columns are positional per
      # dataset and the two schemas are incompatible. Also OFF unless a dataset
      # name is supplied; worker.js no-ops on the missing binding.
      type    = "analytics_engine"
      name    = "EDGE_EVENTS_ANALYTICS"
      dataset = var.edge_events_analytics_dataset
      }] : [], var.chat_service_origin != "" ? [{
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
      expression  = "(http.host eq \"shorted.com.au\" or http.host eq \"www.shorted.com.au\") and http.request.uri.path contains \"/geo/\""
      description = "Cache /geo TopoJSON + boundary assets at edge (non-default extension — CF does not cache .topojson/.json by default, so the origin's s-maxage never took effect)"
      enabled     = true
      action_parameters = {
        cache = true
        edge_ttl = {
          # 1 week, not 1yr: /geo files have STABLE names (no content hash), so
          # a boundary rebuild must be able to propagate without a manual purge.
          mode    = "override_origin"
          default = 604800
          status_code_ttl = [
            {
              status_code_range = {
                from = 200
                to   = 299
              }
              value = 604800
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
              or starts_with(http.request.uri.path, "/api/revalidate")
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
      # Machine-readable public surfaces — the documents we ADVERTISE to agents.
      #
      # SBFM's static-resource bypass is EXTENSION-based (plus the /.well-known/
      # path prefix): `txt|csv|js|css|svg|pdf|…` bypass, but `.xml`, `.json`,
      # `.yaml` and `.md` do NOT. That single fact explains the whole observed
      # split on 2026-08-27 with `-A 'my-app/1.0'`:
      #   200 → /llms.txt, /llms-full.txt, /robots.txt   (`.txt` is static)
      #   200 → /.well-known/api-catalog, /ai-plugin.json (path prefix is static)
      #   403 → /openapi.json, /openapi.yaml, /docs/api.md (cf-mitigated: challenge)
      # …and it is why /sitemap.xml + /feed.xml already needed naming here.
      #
      # Publishing a discovery spine (RFC 9727 catalog, llms.txt, ai-plugin.json,
      # Link: rel=service-desc) that points at documents an agent is then
      # challenged on is the failure mode this rule exists to close.
      #
      # Scope decisions:
      #   - the whole /docs/ tree, not just /docs/api.md: every child is a
      #     read-only public documentation surface (api, api-reference,
      #     llm-context, llm-context-raw) and they cross-link, so exempting one
      #     file just moves the 403 to the next hop an agent follows.
      #   - /.well-known/ is named EXPLICITLY even though Cloudflare currently
      #     bypasses it implicitly — a contract we depend on should not rest on
      #     an undocumented-for-us vendor default.
      #   - /api/search/stocks is a documented public GET in our OpenAPI spec.
      #     It filters a hardcoded in-memory list, mutates nothing, costs nothing
      #     to serve, and keeps its own app-layer limiter (BROWSER_READ_RATE_LIMIT).
      #
      # This skips ONLY SBFM/BIC/Security Level. WAF managed rules still apply,
      # and the zone rate limiter is deliberately NOT skipped here (it only
      # applies to the API host anyway). Nothing here mutates state.
      action      = "skip"
      expression  = <<-EOT
        (
          (http.host eq "shorted.com.au" or http.host eq "www.shorted.com.au")
          and (
            http.request.uri.path eq "/sitemap.xml"
            or http.request.uri.path eq "/feed.xml"
            or http.request.uri.path eq "/openapi.json"
            or http.request.uri.path eq "/openapi.yaml"
            or http.request.uri.path eq "/api/search/stocks"
            or starts_with(http.request.uri.path, "/docs/")
            or starts_with(http.request.uri.path, "/.well-known/")
          )
        )
      EOT
      description = "Allow non-verified feed readers, crawlers and API agents to fetch sitemap.xml, feed.xml, the OpenAPI spec, the /docs tree, /.well-known and the public stock search through SBFM, BIC, and Security Level checks"
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
    },
    {
      # Vercel egress shares a small pool of IPs per region, so ISR
      # regenerations and warm-cache bursts from our OWN SSR fetcher blow the
      # 60 req/10s per-IP ceiling instantly and get 429'd. This rule exempts
      # first-party SSR traffic, and — like the testing bypass — requires BOTH
      # the UA marker and the secret header, never the UA alone.
      action      = "skip"
      expression  = <<-EOT
        (
          http.host eq "${var.domain}"
          or http.host eq "shorted.com.au"
          or http.host eq "www.shorted.com.au"
        )
        and ${local.ssr_bypass_expression}
      EOT
      description = "Allow first-party Vercel SSR traffic through SBFM, BIC, Security Level, and rate-limit checks"
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
  enable_js          = var.javascript_detections_enabled
  # Our app serves robots.txt (Content-Signals + explicit AI-allow groups);
  # Cloudflare's managed robots.txt would prepend conflicting Disallow rules.
  is_robots_txt_managed = false

  # Super Bot Fight Mode — codified from live zone state (dashboard-set before
  # July 2026, previously invisible to terraform plan). These settings are why
  # all HTML/sitemap/feed responses managed-challenge non-verified clients:
  #   - sbfm_definitely_automated = managed_challenge → non-verified automation
  #     gets a challenge on every non-static path.
  #   - sbfm_verified_bots = "allow" is the ONLY thing keeping Googlebot /
  #     Bingbot / GPTBot / ClaudeBot (Cloudflare-verified bots) crawling the
  #     site. A silent dashboard flip to "block" would de-index the site —
  #     managing it here makes that drift visible in plan. NEVER set to block.
  #   - sbfm_static_resource_protection = false → static extensions bypass
  #     SBFM. The bypass is EXTENSION-based
  #     (ico|jpg|png|jpeg|gif|css|js|tif|tiff|bmp|pict|webp|svg|svgz|class|jar|
  #      txt|csv|doc|docx|xls|xlsx|pdf|ps|pls|ppt|pptx|ttf|otf|woff|woff2|eot|
  #      eps|ejs|swf|torrent|midi|mid|m3u8|m4a|mp3|ogg|ts), plus the
  #     /.well-known/ path prefix regardless of extension.
  #     .txt is on it (llms.txt, robots.txt sail through); .xml, .json, .yaml
  #     and .md are NOT — which is why /sitemap.xml, /feed.xml, /openapi.json,
  #     /openapi.yaml and /docs/api.md all need the explicit skip rule in
  #     cloudflare_ruleset.app_api_security_skip above.
  sbfm_definitely_automated       = "managed_challenge"
  sbfm_verified_bots              = "allow"
  sbfm_static_resource_protection = false
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

# Early Hints is OFF because against this origin it does not work at all, and
# its failures dominate our error metrics.
#
# Cloudflare implements Early Hints by probing the origin with its own
# subrequests (user-agent "nginx-ssl early hints" / "bastion early hints") to
# harvest `Link: rel=preload` headers it can later replay as a 103. Next.js on
# Vercel does not emit those headers, and the probes themselves time out:
# measured over 24h on 2026-08-23, 32,568 of 33,979 probes (96%) returned 504
# with originResponseStatus=0, and those probes were 99.98% of ALL 504s on
# shorted.com.au (34,024 of them — 24% of total zone requests for the host).
# Real browser user-agents accounted for ~7 × 504 in the same window.
#
# So this delivered zero preload benefit while generating ~34k failed origin
# requests/day and making the zone look like it had a 24% error rate. Turning
# it off cannot slow any user down — there is no working Early Hints path to
# lose. If Next.js ever emits preload Link headers, re-enable and re-measure
# the probe success rate BEFORE assuming it helps.
resource "cloudflare_zone_setting" "security_early_hints" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "early_hints"
  value      = "off"
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
