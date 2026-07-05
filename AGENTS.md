# AGENTS.md - Cloudflare Edge Gateway Setup

This document describes the Cloudflare edge gateway configuration for Shorted.com.au. Future AI agents should reference this when working on Cloudflare, edge caching, rate limiting, or DNS configuration.

**Status: ACTIVE** — Both frontend (`shorted.com.au`) and API (`api.shorted.com.au`) traffic flow through Cloudflare.

## Overview

Shorted.com.au uses Cloudflare as an edge gateway with a Worker (`shorted-edge-cache`) that routes and caches API traffic. This setup provides:

- Edge caching for API responses (60s-300s TTLs)
- Rate limiting at the edge (60 req/min general, 20 req/min search)
- WAF protection (OWASP Core Ruleset)
- Frontend proxy to Vercel with real IP forwarding
- KV namespace for pre-warmed cache data

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                              │
│                                                                     │
│  shorted.com.au ────────► Orange-cloud A record ──► Vercel          │
│  www.shorted.com.au ───► Orange-cloud CNAME ──────► Vercel          │
│  api.shorted.com.au ───► Worker (shorted-edge-cache)                │
│                             │                                         │
│                             ├── /shorts.v1alpha1.* ──► Shorts API    │
│                             ├── /market_data.v1.*  ──► Market Data   │
│                             ├── /chat.v1.*         ──► Chat Service  │
│                             └── /register.v1.*     ──► Shorts API    │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Files

### Edge Worker
- `services/edge-worker/worker.js` — Main Worker script (multi-origin caching)
- `services/edge-worker/wrangler.toml` — Wrangler config for dev
- `services/edge-worker/prewarm.js` — Cache pre-warming script
- `services/edge-worker/prewarm-wrangler.toml` — Prewarm Worker config

### Terraform Module
- `terraform/modules/cloudflare-edge/main.tf` — DNS, Worker, WAF, rate limiting
- `terraform/modules/cloudflare-edge/variables.tf` — Module variables
- `terraform/modules/cloudflare-edge/outputs.tf` — Module outputs

### Environment Configurations
- `terraform/environments/dev/main.tf` — Dev environment (cloudflare_edge + chat_service modules)
- `terraform/environments/dev/variables.tf` — Dev variables (Cloudflare zone, API key, etc.)
- `terraform/environments/dev/outputs.tf` — Dev outputs
- `terraform/environments/prod/main.tf` — Prod environment (same modules)
- `terraform/environments/prod/variables.tf` — Prod variables
- `terraform/environments/prod/outputs.tf` — Prod outputs

## Edge Worker Caching

### Cache TTLs
| Endpoint Pattern | TTL | Description |
|------------------|-----|-------------|
| GetTopShorts, GetShortsTreeMap, GetWeeklyReport, GetMarketByDate | 300s | Top shorted stocks, treemaps, reports |
| GetStock, GetTimeSeries, GetSearch, GetStockDetails, GetWatchlist | 120s | Stock details, time series, search |
| GetNews, GetAnnouncement | 300s | News and announcements |
| Default | 60s | All other endpoints |

### Bypass (Never Cached)
- `/health`, `/healthz` — Health checks → Shorts API
- `/chat.v1.*` — Chat streaming → Chat Service
- `/register.v1.*` — Auth endpoints → Shorts API
- Requests with gRPC/Connect streaming headers
- `/api/cache/purge` — Cache purge endpoint (requires secret)

### Cache Layers
1. **Hot Cache** — In-memory, 60s TTL, zero latency for popular requests
2. **Cloudflare Cache API** — Edge PoP cache, configurable TTLs
3. **KV Namespace** — Globally consistent pre-warmed cache
4. **Origin** — Cloud Run services

### Cache Headers
Responses include `X-Shorted-Cache` header:
- `HIT` — Served from Cloudflare edge cache
- `MISS` — Fetched from origin, now cached
- `KV` — Served from Worker KV (pre-warmed)
- `BYPASS` — Not cached (auth, streaming, etc.)

## Rate Limiting

### API Rate Limits
| Rule | Expression | Limit | Period | Action |
|------|------------|-------|--------|--------|
| General API | `local.api_rate_limit_expression` -> `http.host eq "api.shorted.com.au"` plus optional trusted-test bypass | 60 req | 10s in prod | Block (429) |
| Search | Deprecated/unused | 20 req | n/a | Kept only for module compatibility |

Rate limits are enforced per IP address at the Cloudflare edge.

### Trusted Testing Bypass

Cloudflare API rate-limit bypass is available for E2E/load testing, but it is intentionally **not** user-agent-only. A request bypasses the Cloudflare `http_ratelimit` rule only when both of these are true:

1. `User-Agent` contains the configured test marker, default `Shorted-E2E`.
2. The configured secret header matches, default header name `x-shorted-testing-bypass`.

The bypass is disabled by default. Enable it in prod Terraform by setting a non-empty secret:

```bash
cd terraform/environments/prod
export TF_VAR_rate_limit_testing_bypass_secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
terraform plan
terraform apply
```

Use it from test clients with both headers:

```bash
curl \
  -H "User-Agent: Shorted-E2E/1.0" \
  -H "X-Shorted-Testing-Bypass: $TF_VAR_rate_limit_testing_bypass_secret" \
  https://api.shorted.com.au/health
```

Relevant Terraform inputs:

| Variable | Default | Purpose |
|----------|---------|---------|
| `rate_limit_testing_bypass_secret` | `""` | Secret required to enable and use the bypass. Empty means no bypass clause is emitted. |
| `rate_limit_testing_bypass_header_name` | `x-shorted-testing-bypass` | Lowercase header name used in the Cloudflare expression. HTTP clients may send any case. |
| `rate_limit_testing_bypass_user_agent` | `Shorted-E2E` | Required user-agent substring. |

Security notes:
- Never create a user-agent-only bypass; UAs are trivial to spoof.
- Do not commit the bypass secret to tracked `*.tfvars` files.
- The secret is embedded in the Cloudflare rule/Terraform state, so rotate it if shared broadly or exposed in CI logs.
- This bypass only excludes requests from the Cloudflare edge rate-limit rule; it does not bypass app authentication, permissions, subscriptions, or backend guardrails.

Regression test:

```bash
node --test terraform/modules/cloudflare-edge/rate-limit-expression.test.mjs
```

## WAF Configuration

- OWASP Core Ruleset (paranoia-level-1)
- Skip WAF for known bots (cf.client.bot)
- Bot protection enabled in prod
- Country blocking configurable (blocked_countries variable)

## Frontend Proxy

Frontend traffic (`shorted.com.au`, `www.shorted.com.au`) is proxied through Cloudflare to Vercel:

- No edge caching for frontend (Vercel handles HTML/asset caching)
- Real client IP forwarded via `CF-Connecting-IP` header
- Vercel's Upstash rate limiting uses the real client IP
- Cloudflare DDoS + WAF protection applies to all frontend traffic

### Cloudflare Web Analytics / RUM

Cloudflare Web Analytics can be enabled either by Cloudflare dashboard injection or by the app's explicit manual beacon. The app renders `web/src/@/components/cloudflare-web-analytics.tsx` only when `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` is set in the web/Vercel environment.

Use Cloudflare RUM page views as the route-level denominator for cost attribution, then join with Worker `edge_request`, Firestore `firestore_operation`, web/backend `product_event`, and backend `cost_event` logs as described in `docs/observability/cost-attribution.md`.

## Provider Authentication

Uses Cloudflare Global API Key + Email (matching Flaggr pattern):
```hcl
provider "cloudflare" {
  api_key = var.cloudflare_global_api_key
  email   = var.cloudflare_email
}
```

Required variables:
- `cloudflare_global_api_key` — Cloudflare Global API Key
- `cloudflare_email` — Cloudflare account email
- `cloudflare_zone_id` — Zone ID for shorted.com.au
- `cache_purge_secret` — Secret for cache purge endpoint

## Environment Variables (Worker Bindings)

| Variable | Description |
|----------|-------------|
| SHORTS_API_ORIGIN | Cloud Run URL for Shorts API |
| CHAT_SERVICE_ORIGIN | Cloud Run URL for Chat Service |
| MARKET_DATA_ORIGIN | Cloud Run URL for Market Data |
| CACHE_TTL_DEFAULT | Default cache TTL (60s) |
| CACHE_TTL_TOP_SHORTS | Top shorts cache TTL (300s) |
| CACHE_TTL_STOCK_DATA | Stock data cache TTL (120s) |
| CACHE_TTL_NEWS | News cache TTL (300s) |
| CACHE_PURGE_SECRET | Cache purge authentication |

## Deployment

### Dev Environment
```bash
cd terraform/environments/dev
terraform init
terraform plan
terraform apply
```

### Prod Environment
```bash
cd terraform/environments/prod
terraform init
terraform plan
terraform apply
```

### Environment Variables Required
```bash
export TF_VAR_cloudflare_email="Ben.ebsworth@gmail.com"
export TF_VAR_cloudflare_global_api_key="<key>"
export TF_VAR_cloudflare_zone_id="<zone_id>"
export TF_VAR_cache_purge_secret="<random>"
```

## Cache Purge

To purge all edge caches:
```bash
curl -X POST https://api.shorted.com.au/api/cache/purge \
  -d "<cache_purge_secret>"
```

## Troubleshooting

For any production, preview, release-smoke, Cloudflare Worker, Vercel, RUM/metrics, API data, 403/404/500, timeout, or cache regression, load the Codex skill first:

```text
Use $shorted-prod-troubleshooting
```

Skill path: `/Users/benebsworth/.codex/skills/shorted-prod-troubleshooting/SKILL.md`. It contains the current evidence checklist for logs, metrics, RUM analytics, build/hook success, E2E smoke, Vercel deployments, Cloudflare wrangler checks, Supabase/data validation, and closeout.

### Worker Not Responding
1. Check Worker route in Cloudflare dashboard: `api.shorted.com.au/*` → `shorted-edge-cache`
2. Verify Worker is deployed: `wrangler deploy --dry-run`
3. Check Worker logs in Cloudflare dashboard → Workers → shorted-edge-cache → Logs

### Rate Limit Not Working
1. Verify rate limiting rules in Cloudflare dashboard → Security → WAF → Rate limiting
2. Check `X-Shorted-Cache` header to confirm requests hit the Worker
3. Verify `cf.ip.src` is in the rate limit characteristics

### Cache Not Working
1. Check `X-Shorted-Cache` header in responses
2. Verify Worker bindings are set correctly
3. Check Worker logs for cache errors
4. Use cache purge endpoint to clear stale data

### Frontend Not Loading
1. Verify DNS records are orange-cloud (proxied)
2. Check Vercel is responding to `https://shorted.com.au`
3. Verify Worker is not interfering with frontend traffic
4. Check `proxyFrontend()` function in worker.js

## Rollback

If issues arise:
1. Set DNS records to grey-cloud (DNS-only) in Cloudflare dashboard
2. Or remove the Cloudflare module and revert to direct Vercel/Cloud Run URLs
3. Worker can be disabled by removing the route in Cloudflare dashboard

## Related Documentation

- `CLOUDFLARE_CUTOVER.md` — Detailed cutover guide and checklist
- `CLAUDE.md` — Full project context and architecture
- `terraform/README.md` — Terraform setup instructions
- `services/edge-worker/BENCHMARK_BASELINE.md` — Worker performance baselines
