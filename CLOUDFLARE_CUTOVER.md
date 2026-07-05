# Cloudflare Edge Gateway Cutover Guide

This document describes the step-by-step cutover process for moving shorted.com.au frontend and api.shorted.com.au API traffic through the Cloudflare edge gateway.

## Architecture

After cutover, all traffic flows through Cloudflare:

```
shorted.com.au ─────► Cloudflare Proxy (orange-cloud) ──► Edge Worker ──► Vercel (Next.js frontend)
api.shorted.com.au ─► Cloudflare Proxy (orange-cloud) ──► Edge Worker ──► Cloud Run (API services)
```

### Edge Worker Capabilities
- **Multi-origin routing**: Routes traffic to Vercel, Shorts API, Chat Service, or Market Data API
- **Edge caching**: 4-tier caching (hot memory → CF Cache API → KV → origin)
- **Rate limiting**: Cloudflare API-host limit is 60 req/10s in prod; browser traffic uses generous Vercel/Upstash buckets (anonymous 3000 burst with 600/min refill, authenticated 3000/min)
- **WAF protection**: Cloudflare Managed Free Ruleset + bot protection
- **Real IP forwarding**: CF-Connecting-IP forwarded to Vercel for Upstash rate limiting

### Cache TTLs
| Endpoint Pattern | TTL | Description |
|------------------|-----|-------------|
| GetTopShorts, GetShortsTreeMap, GetWeeklyReport | 300s | Top shorted stocks, treemaps, reports |
| GetStock*, GetTimeSeries*, GetSearch, GetWatchlist | 120s | Stock details, time series, search |
| GetNews*, GetAnnouncement* | 300s | News and announcements |
| Default | 60s | All other endpoints |

### Pass-through (Never Cached)
- `/health`, `/healthz` → Shorts API
- `/chat.v1.*` → Chat Service (streaming)
- `/register.v1.*` → Shorts API (auth)
- All `shorted.com.au` frontend traffic → Vercel (no caching, Vercel handles HTML/asset caching)

## Pre-Cutover Checklist

### 1. Verify Terraform Configuration
- [ ] `create_frontend_records = true` in `terraform/environments/dev/main.tf`
- [ ] `create_api_record = true` (default)
- [ ] All origin URLs are correct (shorts_api, chat_service, market_data)
- [ ] `frontend_origin = "https://shorted.com.au"`

### 2. Verify Vercel Configuration
- [ ] Custom domain `shorted.com.au` is configured in Vercel
- [ ] Custom domain `www.shorted.com.au` is configured in Vercel
- [ ] Vercel DNS currently points to Vercel nameservers (before cutover)
- [ ] Environment variables are set:
  - `NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT` = `https://api.shorted.com.au`
  - Other production env vars (Stripe, NextAuth, etc.)

### 3. Verify Cloudflare Zone
- [ ] `shorted.com.au` zone exists in Cloudflare
- [ ] Zone ID is configured in `var.cloudflare_zone_id`
- [ ] API key has permissions: DNS:Edit, Worker:Edit, Zone:Edit

### 4. Verify Edge Worker
- [ ] Worker script exists at `services/edge-worker/worker.js`
- [ ] Pre-warm worker script exists at `services/edge-worker/prewarm.js`
- [ ] Wrangler config is valid (`services/edge-worker/wrangler.toml`)

### 5. Verify Terraform State
- [ ] Run `terraform plan` to check for existing resources
- [ ] Ensure no conflicts with existing DNS records
- [ ] Check if DNS records already exist (may need to import them)

## Cutover Steps

### Step 1: Deploy Terraform Infrastructure

Credentials are stored in `.env` at the project root (gitignored).

```bash
cd ~/projects/shorted

# Load credentials from .env (all TF_VAR_* variables are auto-exported)
set -a; source .env; set +a

cd terraform/environments/dev
terraform init
terraform plan
terraform apply
```

**Expected Resources:**
- `cloudflare_record.frontend[0]` — A record: `shorted.com.au` → `76.76.21.21` (Vercel anycast, proxied)
- `cloudflare_record.www` — CNAME: `www.shorted.com.au` → `cname.vercel-dns.com` (proxied)
- `cloudflare_record.api[0]` — CNAME: `api.shorted.com.au` → Cloud Run URL (proxied)
- `cloudflare_workers_script.edge_cache` — Edge Worker with multi-origin support
- `cloudflare_workers_script.prewarm[0]` — Pre-warm Worker (KV population)
- `cloudflare_workers_kv_namespace.edge_cache` — KV namespace for edge cache
- `cloudflare_workers_route.api` — Route: `shorted.com.au/*` → `shorted-edge-cache`
- `cloudflare_workers_cron_trigger.prewarm[0]` — Daily cron (12 PM UTC)
- `cloudflare_ruleset.waf_managed` — WAF managed rules
- `cloudflare_ruleset.rate_limit_api` — API-host rate limiting (60 req/10s in prod)
- `cloudflare_zone_settings_override.tls` — TLS: Full (strict)

### Step 2: Verify DNS Records
After Terraform apply, verify in Cloudflare dashboard:
- `shorted.com.au` → A record → `76.76.21.21` → **Proxied (orange cloud)**
- `www.shorted.com.au` → CNAME → `cname.vercel-dns.com` → **Proxied (orange cloud)**
- `api.shorted.com.au` → CNAME → Cloud Run URL → **Proxied (orange cloud)**

### Step 3: Update Vercel Custom Domains
Vercel needs to know about the new DNS configuration:
1. Go to Vercel Dashboard → shorted project → Settings → Domains
2. Verify `shorted.com.au` and `www.shorted.com.au` show as "Valid Configuration"
3. Vercel may show a warning about DNS pointing to Cloudflare — this is expected
4. The Edge Worker proxies traffic to Vercel with proper headers, so Vercel should accept it

### Step 4: Verify Edge Worker Route
In Cloudflare dashboard:
1. Go to Workers & Pages → `shorted-edge-cache`
2. Check routes: `shorted.com.au/*` → `shorted-edge-cache`
3. Verify Worker is active and responding

### Step 5: Test Frontend Traffic
```bash
# Test frontend (should return 200 with CF edge headers)
curl -I https://shorted.com.au

# Expected headers:
# X-Shorted-Edge: cloudflare
# X-Shorted-Cache: BYPASS
# cf-ray: ...
# server: cloudflare
```

### Step 6: Test API Traffic
```bash
# Test API (should return 200 with cache headers)
curl -I https://api.shorted.com.au/health

# Expected headers:
# X-Shorted-Cache: BYPASS (health checks are never cached)
# X-Shorted-Edge: cloudflare
# server: cloudflare
```

### Step 7: Test Caching
```bash
# First request (MISS)
curl -I https://api.shorted.com.au/shorts.v1alpha1.GetTopShorts -H "Content-Type: application/json" -d '{"period": "weekly"}'

# Second request (should be HIT or HOT)
curl -I https://api.shorted.com.au/shorts.v1alpha1.GetTopShorts -H "Content-Type: application/json" -d '{"period": "weekly"}'
```

### Step 8: Test Rate Limiting
```bash
# Send rapid requests (should get 429 after the prod limit, currently 60 requests in 10 seconds)
for i in {1..70}; do
  curl -s -o /dev/null -w "%{http_code}\n" https://api.shorted.com.au/health
done
```

### Step 8b: Test Trusted Bot/Browser Challenge Bypass
The Cloudflare trusted-test bypass is for bot/browser challenges during E2E/load testing. It is disabled unless `TF_VAR_rate_limit_testing_bypass_secret` is set and applied in `terraform/environments/prod`.

Setup:
```bash
cd terraform/environments/prod
export TF_VAR_rate_limit_testing_bypass_secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
terraform plan
terraform apply
```

Use both headers on test traffic:
```bash
curl -I https://api.shorted.com.au/health \
  -H "User-Agent: Shorted-E2E/1.0" \
  -H "X-Shorted-Testing-Bypass: $TF_VAR_rate_limit_testing_bypass_secret"
```

The Terraform module excludes requests that present both the `Shorted-E2E` user-agent marker and the configured secret header from the API-host rate-limit expression. Keep API smoke serial anyway so backend/application guardrails are still exercised realistically.

Verify challenge bypass:
```bash
for i in {1..100}; do
  curl -s -o /dev/null -w "%{http_code}\n" https://shorted.com.au/shorts/LOT \
    -H "User-Agent: Shorted-E2E/1.0" \
    -H "X-Shorted-Testing-Bypass: $TF_VAR_rate_limit_testing_bypass_secret"
done
```

Security rule: never use a user-agent-only bypass. The Cloudflare challenge-skip expression must require both `http.user_agent contains "Shorted-E2E"` and `any(http.request.headers["x-shorted-testing-bypass"][*] eq "<secret>")`.

### Step 9: Verify Vercel Rate Limiting
The middleware at `web/src/middleware.ts` uses `request.ip` which reads `CF-Connecting-IP` when traffic comes through Cloudflare proxy. Verify:
1. Frontend rate limiting still works with generous browser buckets (anonymous 3000 burst with 600/min refill, authenticated 3000/min)
2. Check Vercel logs to confirm real client IPs are being captured

### Step 10: Verify Pre-warm Worker
The pre-warm worker runs daily at 12 PM UTC (2 hours after ASIC data sync at 10 AM UTC). To test immediately:
```bash
# Call pre-warm endpoint (if configured)
curl -X POST https://shorted-edge-cache.your-subdomain.workers.dev/prewarm \
  -H "Authorization: Bearer $PREWARM_SECRET"
```

## Rollback Plan

If issues arise after cutover:

### Option 1: Grey-Cloud DNS Records
1. In Cloudflare dashboard, set DNS records to DNS-only (grey cloud)
2. Traffic bypasses Cloudflare proxy but still uses Cloudflare DNS
3. Worker no longer intercepts traffic

### Option 2: Remove Worker Route
1. In Cloudflare dashboard → Workers → `shorted-edge-cache` → Routes
2. Remove or disable the `shorted.com.au/*` route
3. Traffic goes directly to origins (Vercel / Cloud Run)

### Option 3: Terraform Revert
```bash
# Set create_frontend_records = false
# Set create_api_record = false
terraform apply
```

## Post-Cutover Monitoring

### 1. Check Cloudflare Analytics
- Go to Cloudflare dashboard → Analytics
- Monitor:
  - Requests (should show traffic through Cloudflare)
  - Cached vs uncached responses
  - Rate limiting triggers
  - WAF blocks

### 2. Monitor Vercel Logs
- Check Vercel dashboard → Logs
- Verify requests are coming through with correct client IPs
- Look for any increase in 4xx/5xx errors

### 3. Monitor Cloud Run Services
- Check Cloud Run metrics:
  - Request count (should decrease due to edge caching)
  - Latency (should improve for cached responses)
  - Error rate

### 4. Monitor Worker Logs
- Cloudflare dashboard → Workers → `shorted-edge-cache` → Logs
- Look for:
  - Cache hit/miss ratios
  - Error rates
  - Origin response times

## Troubleshooting

### Frontend Not Loading
1. Verify DNS records are proxied (orange cloud)
2. Check Vercel is responding to `https://shorted.com.au`
3. Verify Worker is not interfering with frontend traffic
4. Check `proxyFrontend()` function in worker.js

### API Not Responding
1. Verify Worker route: `shorted.com.au/*` → `shorted-edge-cache`
2. Check Worker logs for routing errors
3. Verify origin URLs are correct in Worker bindings
4. Test direct Cloud Run URL to confirm backend is healthy

### Cache Not Working
1. Check `X-Shorted-Cache` header in responses
2. Verify Worker bindings are set correctly
3. Check Worker logs for cache errors
4. Use cache purge endpoint to clear stale data:
   ```bash
   curl -X POST https://api.shorted.com.au/api/cache/purge \
     -d "<cache_purge_secret>"
   ```

### Rate Limiting Issues
1. Verify rate limit rules in Cloudflare dashboard → Security → WAF → Rate limiting
2. Check `X-Shorted-Cache` header to confirm requests hit the Worker
3. Verify rate limit characteristics are `ip.src` and `cf.colo.id`
4. If trusted tests are being limited, confirm all three are true:
   - `TF_VAR_rate_limit_testing_bypass_secret` was set before `terraform apply`
   - test requests send `User-Agent: Shorted-E2E/1.0`
   - test requests send `X-Shorted-Testing-Bypass: <same-secret>`
5. Vercel Upstash rate limiting should still work via CF-Connecting-IP

### Worker Not Responding
1. Check Worker route in Cloudflare dashboard: `shorted.com.au/*` → `shorted-edge-cache`
2. Verify Worker is deployed: `cd services/edge-worker && wrangler deploy --dry-run`
3. Check Worker logs in Cloudflare dashboard → Workers → shorted-edge-cache → Logs
4. Verify all environment variables are set (origins, cache TTLs, purge secret)

## Related Documentation
- `terraform/modules/cloudflare-edge/main.tf` — Terraform module
- `services/edge-worker/worker.js` — Edge Worker script
- `services/edge-worker/prewarm.js` — Pre-warm Worker
- `CLOUDFLARE_CUTOVER.md` — This document
- `CLAUDE.md` — Full project context and architecture
