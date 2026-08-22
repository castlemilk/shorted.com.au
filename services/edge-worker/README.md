# Shorted Edge Worker

Cloudflare Worker fronting **both** `api.shorted.com.au` (multi-tier caching
proxy) and `shorted.com.au` (transparent proxy to Vercel).

| File | Purpose |
|---|---|
| `worker.js` | Main worker — routing, caching, edge reads, **burst + sustained rate limiting on both surfaces** |
| `prewarm.js` | Cron worker that populates KV after the daily ASIC sync |
| `wrangler.toml` | Local dev / dry-run config (**not** the production deploy path) |
| `prewarm-wrangler.toml` | Same, for the prewarm worker |
| `analytics.test.mjs` | Edge analytics event tests |
| `ratelimit.test.mjs` | Edge rate limiting tests |

```bash
node --test services/edge-worker      # run all worker tests
node --check services/edge-worker/worker.js
```

---

## Deployment — Terraform owns this worker, not wrangler

**Important, and contrary to the usual Cloudflare workflow: this worker is not
deployed with `wrangler deploy`.** It is deployed by Terraform:

- `terraform/modules/cloudflare-edge/main.tf` →
  `resource "cloudflare_workers_script" "edge_cache"` with
  `content = file(".../services/edge-worker/worker.js")`
- Every binding (vars, secrets, KV, **rate limit bindings**) is declared in that
  resource's `bindings` list.
- Applied by `.github/workflows/terraform-deploy.yml` against
  `terraform/environments/{dev,prod}`.

Consequences:

- **Worker bindings go in Terraform.** `wrangler.toml` is kept in sync purely so
  `wrangler dev` and `wrangler deploy --dry-run` behave like production. If you
  add a binding, add it in **both** places or local dev silently diverges.
- **Secrets are Terraform variables, not `wrangler secret put`.** They are
  delivered as `secret_text` bindings on the script resource. `wrangler secret
  put` would write to the same worker but the next `terraform apply` would
  overwrite the binding set, so it is the wrong tool here.
- Shipping a worker change = merging to `main` and letting terraform-deploy
  apply. To verify the script parses before that:
  `cd services/edge-worker && npx wrangler deploy --dry-run`.

---

## Rate limiting

Per-minute rate limiting runs **here, at the edge** — not in the Go API.

### Why it moved

The app-layer limiter (`services/pkg/ratelimit`) ran a 7-command Upstash
sliding-window pipeline on **every** request, against the **same** Upstash
database that backs the page cache. That exhausted the database's monthly
command quota; Upstash then rejected writes while still serving reads, which
**simultaneously** degraded rate limiting and froze the page cache.

Per-minute limiting must therefore have **no dependency on Upstash at all**. It
now uses Cloudflare's Workers Rate Limiting API (GA 2025-09-19), which is
in-colo, adds no meaningful latency, and has no external quota.

### What this layer is — and is not

This is a **tier-blind origin-protection ceiling**. Nothing here should ever
fire for a real reader or a paying customer; if it does, the number is wrong,
not the traffic.

| Concern | Where it lives |
|---|---|
| Documented **tier** per-minute limits (anon 30, free 60 API / 120 browser) | `services/pkg/ratelimit`, in-process, zero external I/O |
| **Monthly** quota accounting | `services/pkg/ratelimit/monthly.go`, batched |
| Origin-protection ceilings, both surfaces | **here** |

The worker cannot resolve a caller's paid tier without a database lookup, and
doing one at the edge would reintroduce exactly the coupling we removed.

### Two surfaces

This one script is routed on **both** hostnames — `api.shorted.com.au/*` from
Terraform, `shorted.com.au/*` from a route managed outside it (see the note in
`terraform/modules/cloudflare-edge/main.tf`). The client IP it sees is
completely different on each, and that difference drives the whole design:

| Route | Path | What `cf-connecting-ip` is |
|---|---|---|
| `shorted.com.au/*` | browser → Cloudflare → Vercel | the **real end user** |
| `api.shorted.com.au/*` | direct API clients | the real API caller |
| `api.shorted.com.au/*` | Vercel rewrite proxy (`next.config.mjs`) | a **shared Vercel egress IP** |

That last row is why edge enforcement originally shipped **off**: an anonymous
per-IP bucket on the API host collapses every browser in a region onto a handful
of keys. See "First-party identity" below for how that is now solved.

### Two windows per class

The Cloudflare binding's `period` is a **hard enum: 10 or 60 seconds**, nothing
else. So burst and sustained cannot be one binding — every class that needs both
windows needs two bindings, which is why there are **nine**. The 10s bucket
stops a hammering script within a second or two; the 60s bucket stops a slow
grind the 10s window would never see. **Burst is checked first**, so a 429
carries the shorter, more accurate `Retry-After`.

### The bucket matrix

| Surface | Class | Key | Burst (10s) | Sustained (60s) |
|---|---|---|---|---|
| api | authenticated | `k:<sha256(token)[0:32]>` | 100 | 600 |
| api | anonymous | `a:<client IP>` | 10 | 30 |
| api | first-party (SSR/rewrite) | `f:<Vercel egress IP>` | 600 | — |
| browser | anonymous | `ba:<real client IP>` | 100 | 600 |
| browser | signed in | `bu:<sha256(session cookie)[0:32]>` | 200 | 1200 |

Rationale, per row:

- **api / authenticated.** The documented paid API tier is per-minute
  **unlimited**, so this cannot be a tier ceiling — 600/60s is 10 req/s
  sustained, which leaves a legitimate bulk pull entirely unimpeded and only
  catches a runaway loop or a leaked key. (The 120/min this replaced would have
  throttled paying customers doing exactly what they pay for.)
- **api / anonymous.** The one row where the ceiling equals a documented tier:
  an unauthenticated caller hitting the public API host directly has no
  entitlement beyond the anonymous 30/min. First-party rewrite traffic never
  lands here.
- **api / first-party.** A **runaway detector**, not a tier. Keyed by egress IP
  so one looping Vercel instance is contained without penalising the others, and
  sized (60 req/s per egress IP per colo) so ordinary ISR regeneration bursts
  and rewrite fan-out never reach it. Burst-only on purpose: a 60s window here
  would be measuring normal fan-out, not a fault. **If this ever fires on real
  traffic, raise it.**
- **browser / anonymous.** Measured with Playwright against prod, logged out,
  counting only limitable requests (HTML documents and `/api/auth/*` are never
  limited):

  | Page | Limitable requests per load |
  |---|---|
  | `/shorts/BHP` (the heaviest) | **9** — GetStockData, market-data/historical, GetStockVerdict, GetStockSignals, GetStockGraph, ListStockPoliticians, community summary, 2× auth/session |
  | `/` | 6 |
  | `/top` | 2 |

  Worst realistic human burst = 3-4 stock pages in 10s = **27-36** requests.
  Hardest realistic minute = 10-15 pages = **90-135**. A power user working the
  screener/chart controls fires ~1 RPC per control change, so 15-20 RPCs in 10s
  is reachable. 100/10s and 600/60s are **~3x** and **~4.4x** those. Their job
  is stopping egregious hammering, **not** policing browsing — Cloudflare SBFM
  already challenges automated traffic. Re-measure before tightening.
- **browser / signed in.** Keyed on the **session**, not the IP, so an office,
  university or CGNAT egress cannot collapse every colleague into one bucket.
  Double the anonymous allowance. The chunked next-auth cookie spelling
  (`<name>.0`, `.1`, …) is reassembled — missing it would silently drop
  signed-in users with a large JWT into the anonymous bucket.

Tokens and session cookies are **hashed** before they become part of a key —
raw credentials never enter rate-limit state, and each class has a distinct key
prefix so a token hash can never collide with an IP or a session hash.

Counters are **per-colo and eventually consistent** (documented Cloudflare
behaviour), so the effective global ceiling is the configured limit times the
number of colos a client reaches. That is fine for a ceiling, and is a second
reason the precise monthly quota stays app-side.

### Path scoping

On the **API host** everything is eligible except the exemptions below — the
host serves nothing but API traffic.

On the **browser host** only API-ish paths are eligible. Every HTML document
route, static asset and Next.js chunk is untouched: limiting a document route
would blank the site for a real reader and could throttle a crawler mid-crawl.
The eligible list mirrors `web/src/middleware.ts`'s old `RATE_LIMITED_PATHS`
plus the rewrite-proxied prefixes in `web/next.config.mjs` (from the browser's
point of view those are same-origin API calls):

```
/api/market-data  /api/search  /api/community  /api/stripe/checkout
/api/stripe/portal  /api/stocks  /api/algolia  /edge/v1/
/chat.v1.ChatService  /register.v1.RegisterService
/shorts.v1alpha1.<Anything>Service/...
```

Never limited on **either** surface: `/health`, `/healthz`, `/api/health`, and
**`/api/auth/*`**. That last one is load-bearing — next-auth's session endpoint
fires on every page load (2 of the 9 requests on `/shorts/BHP`), so limiting it
would break sign-in state during ordinary browsing.

### Verified search crawlers are never limited

**SEO is the product.** A 429 to Googlebot is not a throttle, it is a crawl-rate
penalty that suppresses indexation for days. Crawlers skip every bucket on both
surfaces.

`request.cf.botManagement.verifiedBot` is the authoritative signal, but that
object is only populated when Cloudflare Bot Management is active on the zone.
When it is absent we cannot verify, and we deliberately choose the **SEO-safe
error**: a request whose user-agent claims to be a search crawler is skipped.
That is spoofable — but all it buys an attacker is exemption from an
origin-protection ceiling, while the zone WAF, SBFM (`sbfm_verified_bots =
"allow"`) and DDoS layers still apply. Losing indexation is the worse failure.
Set `edge_rate_limit_trust_crawler_ua = false` to require real verification.

### First-party identity (what unblocked enablement)

`next.config.mjs` rewrites the Connect-RPC paths to `api.shorted.com.au` on
purpose, so client-side reads hit this worker's cache. That rewrite is performed
**by Vercel**, so the worker sees a shared Vercel egress IP — indistinguishable
from an anonymous scraper.

Next.js rewrites cannot add headers, but **middleware can**: request headers set
via `NextResponse.next({ request: { headers } })` are what the downstream rewrite
sends to its destination. `web/src/middleware.ts` therefore stamps the same
first-party marker the SSR fetcher uses (`web/src/app/actions/config.ts`):

- header `x-shorted-ssr-bypass: <SHORTED_SSR_BYPASS_SECRET>`
- user-agent **appended** with `shorted-web-ssr/1.0 (+https://shorted.com.au)`
  — appended, never replaced, so the real client UA survives as a prefix and
  crawler identification above still works

The worker then routes those into the first-party runaway bucket instead of the
anonymous per-IP one. The end user is still limited — by their **real** IP, one
hop earlier, on the `shorted.com.au` route.

If `SHORTED_SSR_BYPASS_SECRET` is unset in an environment the request simply
passes through unmarked and is treated as anonymous. That is the status quo, not
a regression, but it *is* the precondition for enabling enforcement.

**Proving it in production** (the header-propagation-through-rewrite step cannot
be proven by unit test — the jest harness's Request polyfill exposes
`NextRequest.headers` as a bare Map, so no inbound header survives into
middleware there, and `next dev` does not exercise the Vercel rewrite proxy):

```bash
# 1. On a preview deployment with the secret set, hit a rewrite-proxied RPC and
#    read the bucket the edge charged it to.
curl -si https://<preview>.vercel.app/shorts.v1alpha1.MarketService/GetTopShorts \
  -H 'content-type: application/json' -H 'connect-protocol-version: 1' \
  --data '{"period":"3m","limit":1}' | grep -i 'x-ratelimit-bucket'
# 2. Or force a 429 by temporarily setting edge_rate_limit_first_party_burst_requests
#    to 1 in a preview env: a marked request comes back
#    X-RateLimit-Bucket: first-party, an unmarked one comes back api-anon.
```

The 429 response always carries `X-RateLimit-Bucket`, which is the fastest way
to confirm classification without shell access to the worker.

### Bypasses (must mirror the zone skip rules)

| Class | UA marker | Secret header | Effect |
|---|---|---|---|
| Trusted E2E / load tests | `Shorted-E2E` | `x-shorted-testing-bypass` | skips **every** bucket |
| First-party Vercel traffic | `shorted-web-ssr` | `x-shorted-ssr-bypass` | **routed** to the first-party bucket, not skipped |

**Both** the UA marker and the exact secret are required — never the UA alone,
which anyone can spoof. An empty secret disables that class entirely. This is
the same rule the Terraform expressions enforce.

### Failure behaviour

The limiter fails **open** in every ambiguous case: missing binding, throwing
binding, malformed outcome, unknown class, ineligible path — and enforcement is
**opt-in**: anything other than `EDGE_RATE_LIMIT_ENABLED=true` (including the
flag being absent) disables it. Rate limiting must never be the reason the site
or API is down.

### Configuration

Terraform variables (`terraform/modules/cloudflare-edge/variables.tf`) are the
single source of truth; the compiled-in defaults in `worker.js` are only the
fail-safe used when a var is missing.

| Variable | Default | Meaning |
|---|---|---|
| `edge_rate_limit_enabled` | `true` (module) / `false` (prod, pinned) | Master switch → `EDGE_RATE_LIMIT_ENABLED` |
| `edge_rate_limit_trust_crawler_ua` | `true` | Trust a crawler UA when Bot Management can't verify |
| `edge_rate_limit_key_burst_requests` | `100` | api / authenticated, 10s |
| `edge_rate_limit_key_requests_per_minute` | `600` | api / authenticated, 60s |
| `edge_rate_limit_anon_burst_requests` | `10` | api / anonymous, 10s |
| `edge_rate_limit_anon_requests_per_minute` | `30` | api / anonymous, 60s |
| `edge_rate_limit_first_party_burst_requests` | `600` | first-party runaway detector, 10s |
| `edge_rate_limit_browser_anon_burst_requests` | `100` | browser / anonymous, 10s |
| `edge_rate_limit_browser_anon_requests_per_minute` | `600` | browser / anonymous, 60s |
| `edge_rate_limit_browser_auth_burst_requests` | `200` | browser / signed in, 10s |
| `edge_rate_limit_browser_auth_requests_per_minute` | `1200` | browser / signed in, 60s |
| `edge_rate_limit_*_namespace_id` | `"2001"`–`"2009"` | CF rate-limit namespaces, one per binding |

`namespace_id` is an account-scoped identifier **you choose** — there is no
provisioning step. Two bindings sharing a `namespace_id` share counters *even
across different Workers on the account*, so keep all nine unique.

Binding syntax reference:
<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>

### Enablement and rollback

There is **no dev Cloudflare stack** — `terraform/environments/dev` does not
instantiate this module, so there is no soak environment. The module default is
`true` (any new environment gets protection by default); **production pins the
value explicitly** from the root variable `edge_rate_limit_enabled`, which
defaults to `false`.

**Preconditions** (verify before flipping):

1. `web/src/middleware.ts` is deployed — it attaches the first-party marker to
   rewrite-proxied RPCs. Without it, browser traffic behind the Vercel rewrite
   lands in the anonymous per-IP bucket.
2. `SHORTED_SSR_BYPASS_SECRET` is set in Vercel production **and**
   `TF_VAR_rate_limit_ssr_bypass_secret` (GitHub secret
   `CLOUDFLARE_SSR_BYPASS_SECRET`) is set in CI — both sides of the same secret.
3. Terraform has been applied at least once so the nine `ratelimit` bindings
   exist on the script. Applying the bindings is safe while the flag is off:
   the worker never calls them.

**Enable:**

```bash
cd terraform/environments/prod
terraform plan -var 'edge_rate_limit_enabled=true'   # expect: one plain_text binding change
terraform apply -var 'edge_rate_limit_enabled=true'
```

(or set `edge_rate_limit_enabled = true` in the environment's tfvars / the
CI `TF_VAR_edge_rate_limit_enabled` variable so it survives the next apply.)

**Watch, for the first hour and then daily for a week:**

- **429 rate** — Cloudflare dashboard → Workers → `shorted-edge-cache` →
  Metrics, and the zone Analytics "Status codes" panel. Baseline before the
  flip; any sustained rise in 429 that is not matched by a traffic spike means
  a bucket is too tight.
- **`X-RateLimit-Bucket` distribution** — the header on every edge 429 names the
  class. `browser-anon` 429s in normal hours = the browser numbers are wrong.
  `api-anon` 429s at meaningful volume = first-party identity is **not**
  reaching the worker (check the middleware deploy and the secret).
- **`edge_ratelimit_error` log lines** — a limiter fault; the worker fails open
  but the binding is broken.
- **Search Console crawl stats** — a crawl-rate drop is the expensive failure
  mode. The crawler skip should prevent it; verify it did.

**Rollback is instant and requires no code deploy:**

```bash
cd terraform/environments/prod
terraform apply -var 'edge_rate_limit_enabled=false'   # ~30s to propagate
```

The worker returns to fail-open immediately — the flag is checked before any
bucket is consulted. To loosen rather than disable, raise the offending
`edge_rate_limit_*` variable instead; it is the same one-line apply.

### Operator actions required for rollout

1. **Apply Terraform** (see above) so the nine `ratelimit` bindings and the
   bypass `secret_text` bindings reach the worker. The bypass secrets come from
   the existing CI variables `TF_VAR_rate_limit_testing_bypass_secret` and
   `TF_VAR_rate_limit_ssr_bypass_secret`. No new secret needs minting — but if
   either is unset in an environment, that class is disabled there.

2. **Nothing.** App-layer quota accounting used to need a dedicated Upstash
   database provisioned and wired up; it now lives in Postgres
   (`api_usage_monthly`, migration 000112, applied by the deploy) on the pool
   the API already holds. Rate limiting has no Redis dependency at all — see
   the Rate Limiting section of the root `CLAUDE.md`.

3. **Verify at the edge** after enabling:

   ```bash
   # anonymous API bucket (10/10s) — expect 429s after ~10 requests
   for i in $(seq 1 40); do
     curl -s -o /dev/null -w '%{http_code}\n' https://api.shorted.com.au/edge/v1/top-shorts
   done | sort | uniq -c

   # a browser HTML route must NEVER be limited, however hard you hit it
   for i in $(seq 1 200); do
     curl -s -o /dev/null -w '%{http_code}\n' https://shorted.com.au/top
   done | sort | uniq -c   # expect: no 429 at all
   ```

If you ever *do* need to deploy this worker with wrangler (emergency, Terraform
broken), the config in `wrangler.toml` is complete except for secrets, which
would then need:

```bash
cd services/edge-worker
npx wrangler secret put RATE_LIMIT_TESTING_BYPASS_SECRET
npx wrangler secret put RATE_LIMIT_SSR_BYPASS_SECRET
npx wrangler secret put CACHE_PURGE_SECRET
npx wrangler deploy
```

Treat that as a break-glass path only: the next `terraform apply` re-asserts the
Terraform-declared binding set.
