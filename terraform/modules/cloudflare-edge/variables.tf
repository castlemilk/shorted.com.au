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

variable "public_daily_cache_ttl" {
  description = "Public GET edge-read max-age/s-maxage for daily-updated API data"
  type        = number
  default     = 3600
}

variable "public_stale_cache_ttl" {
  description = "Public GET edge-read stale-while-revalidate window for daily-updated API data"
  type        = number
  default     = 86400
}

variable "static_cache_ttl" {
  description = "Cache TTL for static assets (images, fonts, JS/CSS)"
  type        = number
  default     = 86400
}

variable "stock_page_cache_ttl" {
  description = "Cloudflare edge cache TTL for public stock detail HTML pages"
  type        = number
  default     = 86400
}

variable "cache_rules_enabled" {
  description = "Enable edge cache rules for frontend static assets (evaluated before Worker)"
  type        = bool
  default     = true
}

variable "edge_analytics_sample_rate" {
  description = "Sample rate for JSON edge request analytics logs emitted by the Worker (0 disables, 1 logs every request)"
  type        = number
  default     = 0.01

  validation {
    condition     = var.edge_analytics_sample_rate >= 0 && var.edge_analytics_sample_rate <= 1
    error_message = "edge_analytics_sample_rate must be between 0 and 1."
  }
}

# Sample rate for the ALLOWED arm of the edge_rate_limit event stream only.
#
# LIMITED decisions are ALWAYS emitted at 100% and this variable cannot change
# that — a 429 is rare and high-signal, and sampling it at 1% would hide almost
# every one. This number is the denominator's rate: the volume of eligible
# requests that were let through.
#
# -1 (the default) means "inherit edge_analytics_sample_rate", so there is one
# number to turn by default. Set it explicitly (e.g. 0.001) only when the
# allowed arm is too expensive at the general analytics rate.
variable "edge_rate_limit_sample_rate" {
  description = "Sample rate for ALLOWED edge_rate_limit events (-1 inherits edge_analytics_sample_rate). Limited decisions are always emitted at 100%."
  type        = number
  default     = -1

  validation {
    condition     = var.edge_rate_limit_sample_rate == -1 || (var.edge_rate_limit_sample_rate >= 0 && var.edge_rate_limit_sample_rate <= 1)
    error_message = "edge_rate_limit_sample_rate must be -1 (inherit) or between 0 and 1."
  }
}

# Cloudflare Workers Analytics Engine dataset for rate limit decisions.
#
# DISABLED BY DEFAULT (""): no binding is attached, and worker.js no-ops on the
# missing binding. Set to a dataset name (e.g. "shorted_edge_rate_limit") to
# turn on writeDataPoint, which makes "429s by bucket over time" a SQL query
# against the Analytics Engine SQL API instead of a log grep.
#
# Requires a Workers Paid subscription on the account (confirmed present).
# Datasets are created implicitly on first write; there is no dataset resource
# to declare.
variable "edge_rate_limit_analytics_dataset" {
  description = "Analytics Engine dataset name for edge_rate_limit data points. Empty string leaves the binding unattached (feature off)."
  type        = string
  default     = ""
}

# Sample rate for the edge_upstream_latency stream.
#
# This stream is bucketed latency by cache_status and rpc_method — the "which
# RPCs are slow, and is the cache earning its keep" question. It is a
# distribution, so it is meaningful at a low rate; it is also the one stream you
# may legitimately want to turn UP well above the general analytics rate while
# investigating a latency regression, without multiplying the cost of every
# other event. -1 inherits edge_analytics_sample_rate.
variable "edge_upstream_latency_sample_rate" {
  description = "Sample rate for edge_upstream_latency events (-1 inherits edge_analytics_sample_rate)."
  type        = number
  default     = -1

  validation {
    condition     = var.edge_upstream_latency_sample_rate == -1 || (var.edge_upstream_latency_sample_rate >= 0 && var.edge_upstream_latency_sample_rate <= 1)
    error_message = "edge_upstream_latency_sample_rate must be -1 (inherit) or between 0 and 1."
  }
}

# Sample rate for the ROUTINE arm of edge_bypass_used only.
#
# The `testing` class and every `rejected` outcome are emitted at 100% and this
# variable CANNOT change that — those are the leaked-secret and probe detectors,
# and sampling a rare security signal at 1% means never seeing it.
#
# What this samples is the `ssr` accepted/unconfigured arm, which is EVERY
# first-party request the Vercel rewrites proxy: the steady state, the highest
# volume class on the API host, and a condition that is true by design.
# -1 inherits edge_analytics_sample_rate.
variable "edge_bypass_sample_rate" {
  description = "Sample rate for routine (accepted SSR) edge_bypass_used events (-1 inherits edge_analytics_sample_rate). Testing-class and rejected outcomes are always 100%."
  type        = number
  default     = -1

  validation {
    condition     = var.edge_bypass_sample_rate == -1 || (var.edge_bypass_sample_rate >= 0 && var.edge_bypass_sample_rate <= 1)
    error_message = "edge_bypass_sample_rate must be -1 (inherit) or between 0 and 1."
  }
}

# Cloudflare Workers Analytics Engine dataset for edge_origin_error and
# edge_upstream_latency.
#
# DELIBERATELY A SECOND DATASET, not edge_rate_limit_analytics_dataset.
# Analytics Engine columns are positional PER DATASET, and the rate limit
# schema is pinned to rate limit fields; two differently-shaped events cannot
# share one table without writing nonsense into each other's columns. These two
# events DO share a shape (origin, outcome class, RPC, duration), so they share
# one dataset keyed by blob1/index1.
#
# DISABLED BY DEFAULT (""): no binding is attached and worker.js no-ops. The
# JSON console line is the source of truth either way. Set a dataset name to
# make "is the origin healthy right now" and "which RPCs are slow" SQL queries
# rather than log greps — which matters here because the account has NO Logpush
# job configured.
variable "edge_events_analytics_dataset" {
  description = "Analytics Engine dataset name for edge_origin_error + edge_upstream_latency data points. Empty string leaves the binding unattached (feature off)."
  type        = string
  default     = ""
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

# ---- Edge (Worker) rate limiting — burst + sustained bucket matrix ----
#
# These configure the Cloudflare Workers Rate Limiting API bindings consumed by
# services/edge-worker/worker.js. Per-minute limiting moved to the edge from the
# app-layer Upstash limiter after the shared Upstash database's command quota
# was exhausted, which degraded rate limiting AND froze the page cache in the
# same failure.
#
# WHAT THIS LAYER IS. A tier-blind ORIGIN-PROTECTION ceiling. It is not the
# place documented tier limits are enforced — the free 60/min API and 120/min
# browser tiers are enforced in-process in services/pkg/ratelimit, and monthly
# quotas are accounted there too. Nothing here should ever fire for a real user
# or a paying customer; if it does, the number is wrong, not the traffic.
#
# WHY EVERY CLASS HAS TWO NUMBERS. The Cloudflare binding's `period` is a hard
# enum of 10 or 60 seconds, so "burst" and "sustained" cannot be one binding.
# The 10s bucket stops a hammering script within a second or two; the 60s bucket
# stops a slow grind the 10s window would never see.
#
# WHERE THE BROWSER NUMBERS COME FROM (measured with Playwright against prod,
# logged out, counting only limitable requests — HTML documents and /api/auth
# are never limited):
#
#     /shorts/BHP   9 limitable requests per page load (the heaviest page)
#     /             6
#     /top          2
#
# Worst realistic human burst = 3-4 stock pages in 10s = 27-36 requests.
# Hardest realistic minute = 10-15 pages = 90-135 requests. A power user working
# screener/chart controls fires ~1 RPC per control change, so 15-20 RPCs in 10s
# is reachable. The anonymous browser defaults below (100/10s, 600/60s) are ~3x
# and ~4.4x those measurements. Re-measure before tightening.

variable "edge_rate_limit_enabled" {
  description = <<-EOT
    Enable the worker's edge rate limiting (all buckets, both surfaces).

    Default ON at the module level. The precondition that kept this off when it
    first shipped is now met: rewrite-proxied traffic carries a first-party
    identity (web/src/middleware.ts attaches the SSR bypass header), so shared
    Vercel egress IPs no longer land in the anonymous per-IP bucket — they land
    in the first-party runaway bucket instead.

    Production pins this explicitly from a root variable so enabling prod stays
    a deliberate, single-line tfvar change with an instant rollback. See
    services/edge-worker/README.md, "Enablement and rollback".
  EOT
  type        = bool
  default     = true
}

variable "edge_rate_limit_trust_crawler_ua" {
  description = <<-EOT
    When Cloudflare Bot Management is not populating request.cf.botManagement,
    treat a search-crawler user-agent as a crawler and skip rate limiting.

    SEO is the product: a 429 to Googlebot is a crawl-rate penalty that
    suppresses indexation for days, so the SEO-safe error is the one we choose.
    The UA is spoofable, but all it buys is exemption from an origin-protection
    ceiling — the zone WAF, SBFM (sbfm_verified_bots = "allow") and DDoS layers
    still apply. Set false to require a real verifiedBot signal.
  EOT
  type        = bool
  default     = true
}

# --- api.shorted.com.au, authenticated (keyed by SHA-256 of the token) ---

variable "edge_rate_limit_key_burst_requests" {
  description = "10-second burst ceiling for a single API credential. A runaway/abuse ceiling, NOT a tier — the documented paid API tier is per-minute unlimited."
  type        = number
  default     = 100
}

variable "edge_rate_limit_key_requests_per_minute" {
  description = <<-EOT
    60-second ceiling for a single API credential (keyed by SHA-256 of the
    token). This is a RUNAWAY/ABUSE ceiling, not a tier: the worker cannot
    resolve a caller's paid tier without a database lookup, and the documented
    paid API tier is per-minute UNLIMITED. 600/60s is 10 req/s sustained, which
    leaves a legitimate bulk pull entirely unimpeded while still stopping a
    leaked or shared key from hammering the origin. (The previous 120 would have
    throttled paying customers doing exactly what they pay for.)
  EOT
  type        = number
  default     = 600
}

# --- api.shorted.com.au, anonymous (keyed by real client IP) ---

variable "edge_rate_limit_anon_burst_requests" {
  description = "10-second burst ceiling for unauthenticated direct API callers, keyed by client IP. Proportional to the documented anonymous API tier of 30/min."
  type        = number
  default     = 10
}

variable "edge_rate_limit_anon_requests_per_minute" {
  description = "60-second ceiling for unauthenticated direct API callers, keyed by client IP. Matches the documented anonymous API tier (30/min) exactly — an anonymous caller hitting the public API host directly has no entitlement beyond it. First-party rewrite traffic never lands here."
  type        = number
  default     = 30
}

# --- api.shorted.com.au, first-party (Vercel SSR + the Next.js rewrite proxy) ---

variable "edge_rate_limit_first_party_burst_requests" {
  description = <<-EOT
    10-second ceiling for proven first-party traffic (SSR bypass secret), keyed
    by Vercel egress IP. A RUNAWAY DETECTOR, not a tier: it exists so an ISR
    regeneration loop cannot melt the origin, and it is sized so that ordinary
    regeneration bursts and rewrite fan-out never reach it. 600/10s is 60 req/s
    from a single egress IP in a single colo. If this ever fires on real
    traffic, RAISE IT — it carries no entitlement meaning. Burst-only on
    purpose: a 60s window here would be measuring normal fan-out, not a fault.
  EOT
  type        = number
  default     = 600
}

# --- shorted.com.au, anonymous browser (keyed by REAL client IP) ---

variable "edge_rate_limit_browser_anon_burst_requests" {
  description = "10-second ceiling for anonymous browser API calls, keyed by the real client IP. Default 100 is ~3x the measured worst human burst (3-4 stock pages in 10s = 27-36 limitable requests). See the measurement note at the top of this section."
  type        = number
  default     = 100
}

variable "edge_rate_limit_browser_anon_requests_per_minute" {
  description = "60-second ceiling for anonymous browser API calls, keyed by the real client IP. Default 600 is ~4.4x the measured hardest browsing minute (10-15 pages = 90-135 limitable requests). Its job is stopping egregious hammering, not policing browsing — Cloudflare SBFM already challenges automated traffic."
  type        = number
  default     = 600
}

# --- shorted.com.au, signed-in browser (keyed by session-cookie hash) ---

variable "edge_rate_limit_browser_auth_burst_requests" {
  description = "10-second ceiling for signed-in browser API calls, keyed by a hash of the next-auth session cookie (NOT the IP, so an office/CGNAT egress cannot collapse colleagues into one bucket). Double the anonymous allowance."
  type        = number
  default     = 200
}

variable "edge_rate_limit_browser_auth_requests_per_minute" {
  description = "60-second ceiling for signed-in browser API calls, keyed by a hash of the next-auth session cookie. Double the anonymous allowance."
  type        = number
  default     = 1200
}

# --- Namespace IDs ---
#
# `namespace_id` is an account-scoped identifier YOU choose — there is no
# provisioning step. Two bindings sharing one share counters EVEN ACROSS
# DIFFERENT WORKERS on the account, so every ID below must stay unique.
# Convention here: 20xx, burst and sustained adjacent per class.

variable "edge_rate_limit_key_namespace_id" {
  description = "Rate limiting namespace ID for the per-token 60s bucket."
  type        = string
  default     = "2001"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_key_namespace_id))
    error_message = "edge_rate_limit_key_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_anon_namespace_id" {
  description = "Rate limiting namespace ID for the anonymous per-IP 60s bucket."
  type        = string
  default     = "2002"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_anon_namespace_id))
    error_message = "edge_rate_limit_anon_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_key_burst_namespace_id" {
  description = "Rate limiting namespace ID for the per-token 10s burst bucket."
  type        = string
  default     = "2003"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_key_burst_namespace_id))
    error_message = "edge_rate_limit_key_burst_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_anon_burst_namespace_id" {
  description = "Rate limiting namespace ID for the anonymous per-IP 10s burst bucket."
  type        = string
  default     = "2004"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_anon_burst_namespace_id))
    error_message = "edge_rate_limit_anon_burst_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_first_party_namespace_id" {
  description = "Rate limiting namespace ID for the first-party (SSR/rewrite) 10s runaway bucket."
  type        = string
  default     = "2005"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_first_party_namespace_id))
    error_message = "edge_rate_limit_first_party_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_browser_anon_burst_namespace_id" {
  description = "Rate limiting namespace ID for the anonymous browser 10s burst bucket."
  type        = string
  default     = "2006"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_browser_anon_burst_namespace_id))
    error_message = "edge_rate_limit_browser_anon_burst_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_browser_anon_namespace_id" {
  description = "Rate limiting namespace ID for the anonymous browser 60s bucket."
  type        = string
  default     = "2007"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_browser_anon_namespace_id))
    error_message = "edge_rate_limit_browser_anon_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_browser_auth_burst_namespace_id" {
  description = "Rate limiting namespace ID for the signed-in browser 10s burst bucket."
  type        = string
  default     = "2008"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_browser_auth_burst_namespace_id))
    error_message = "edge_rate_limit_browser_auth_burst_namespace_id must be a stringified positive integer."
  }
}

variable "edge_rate_limit_browser_auth_namespace_id" {
  description = "Rate limiting namespace ID for the signed-in browser 60s bucket."
  type        = string
  default     = "2009"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.edge_rate_limit_browser_auth_namespace_id))
    error_message = "edge_rate_limit_browser_auth_namespace_id must be a stringified positive integer."
  }
}

variable "rate_limit_testing_bypass_secret" {
  description = "Optional shared secret that allows trusted E2E/load-test traffic to bypass Cloudflare bot/browser challenges when paired with the configured test user-agent. Leave empty to disable."
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition = var.rate_limit_testing_bypass_secret == "" || (
      length(var.rate_limit_testing_bypass_secret) >= 16 &&
      can(regex("^[A-Za-z0-9._~:-]+$", var.rate_limit_testing_bypass_secret))
    )
    error_message = "rate_limit_testing_bypass_secret must be empty or a URL-safe token of at least 16 characters."
  }
}

variable "rate_limit_testing_bypass_header_name" {
  description = "Lowercase HTTP header name carrying the Cloudflare trusted testing bypass secret."
  type        = string
  default     = "x-shorted-testing-bypass"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.rate_limit_testing_bypass_header_name))
    error_message = "rate_limit_testing_bypass_header_name must be lowercase letters, numbers, and hyphens only."
  }
}

variable "rate_limit_testing_bypass_user_agent" {
  description = "User-agent substring required with the bypass secret for trusted E2E/load-test traffic."
  type        = string
  default     = "Shorted-E2E"

  validation {
    condition     = length(var.rate_limit_testing_bypass_user_agent) > 0 && can(regex("^[A-Za-z0-9._~+/-]+$", var.rate_limit_testing_bypass_user_agent))
    error_message = "rate_limit_testing_bypass_user_agent must be a non-empty token without spaces, quotes, or backslashes."
  }
}

variable "rate_limit_ssr_bypass_secret" {
  description = "Optional shared secret that allows shorted.com.au's own Vercel SSR fetcher to bypass the Cloudflare zone rate limit when paired with the configured SSR user-agent marker. Server-held only — never expose to browsers. Leave empty to disable."
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition = var.rate_limit_ssr_bypass_secret == "" || (
      length(var.rate_limit_ssr_bypass_secret) >= 16 &&
      can(regex("^[A-Za-z0-9._~:-]+$", var.rate_limit_ssr_bypass_secret))
    )
    error_message = "rate_limit_ssr_bypass_secret must be empty or a URL-safe token of at least 16 characters."
  }
}

variable "rate_limit_ssr_bypass_header_name" {
  description = "Lowercase HTTP header name carrying the first-party SSR bypass secret."
  type        = string
  default     = "x-shorted-ssr-bypass"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.rate_limit_ssr_bypass_header_name))
    error_message = "rate_limit_ssr_bypass_header_name must be lowercase letters, numbers, and hyphens only."
  }
}

variable "rate_limit_ssr_bypass_user_agent" {
  description = "User-agent substring required with the SSR bypass secret for first-party Vercel SSR traffic."
  type        = string
  default     = "shorted-web-ssr"

  validation {
    condition     = length(var.rate_limit_ssr_bypass_user_agent) > 0 && can(regex("^[A-Za-z0-9._~+/-]+$", var.rate_limit_ssr_bypass_user_agent))
    error_message = "rate_limit_ssr_bypass_user_agent must be a non-empty token without spaces, quotes, or backslashes."
  }
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

variable "javascript_detections_enabled" {
  description = <<-EOT
    Cloudflare Bot Management JavaScript Detections zone toggle. Keep true for
    zone-wide automatic injection. Set false only when the frontend is deployed
    with manual JavaScript Detections on sensitive browser paths.
  EOT
  type        = bool
  default     = true
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

variable "web_analytics_rum" {
  description = "Cloudflare Web Analytics RUM zone setting. \"on\" enables automatic beacon injection for proxied hostnames when Web Analytics is configured for the zone."
  type        = string
  default     = "on"

  validation {
    condition     = contains(["on", "off"], var.web_analytics_rum)
    error_message = "web_analytics_rum must be \"on\" or \"off\"."
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
