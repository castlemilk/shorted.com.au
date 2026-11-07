# Rate limiting: the design record

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

Companions: `docs/rate-limiting.md` (the operator reference and debugging runbook) and `services/edge-worker/README.md` (the edge layer). The numbers live in `services/pkg/ratelimit/config.go`.

## Rate Limiting

**Operator/engineer reference: `docs/rate-limiting.md`** — caller classes and
what each is entitled to, the three-layer identity chain, the response contract,
and a debugging runbook (is it on? which class am I in? who is actually being
metered? is the quota store healthy? edge 429 or app 429?). What follows here is
the shape and the landmines; the numbers live in
`services/pkg/ratelimit/config.go`.

Rate limiting is **split across three failure domains on purpose**:

| Concern | Where it runs | Depends on |
|---|---|---|
| Tier-blind **abuse ceiling** | Cloudflare edge worker (`services/edge-worker/worker.js`) | Cloudflare Workers Rate Limiting API only |
| **Per-tier per-minute** limiting | Go API (`services/pkg/ratelimit`, `minute.go`) | **nothing** — in process, per instance |
| **Monthly** quota accounting | Go API (`services/pkg/ratelimit`, `monthly.go`) | **Postgres** (`api_usage_monthly`), batched |
| Zone-level DDoS/abuse limit | Cloudflare zone ruleset (Terraform) | Cloudflare only |

**The rate-limit path touches Upstash zero times.** Upstash is the page cache's
alone. (The Next.js middleware limiter in `web/` is a separate surface and still
uses Upstash via `web/src/@/lib/redis-env.ts`.)

### Why it is split (the August 2026 incident)

The app-layer limiter used to run a **7-command Upstash sliding-window pipeline
on every request**, against the **same Upstash database that backs the page
cache**. That burned the shared database's 500k/month command cap. Upstash then
**rejected writes while still serving reads**, which *simultaneously* degraded
rate limiting and froze the page cache — one quota, two outages.

Three rules came out of it, and they are load-bearing:

1. **Rate limiting must not depend on Upstash at all.** Not "on a dedicated
   database", not "at low volume" — at all. There are deliberately **no
   `RATE_LIMIT_UPSTASH_*` env vars and no Redis fields on `ratelimit.Config`**;
   a test asserts their absence. Quota counters live in Postgres
   (`api_usage_monthly`, migration 000112), on the pool the API already holds,
   where there is no per-command billing cap to exhaust and no second tenant to
   take down.
2. **Quota accounting must not become a second capacity problem.** It reuses
   the store's `pgxpool` (never opens its own — Supabase `max_connections` is
   shared across services) and does **no I/O on the request path**: writes are
   batched into one multi-row statement per flush, reads are a cache-miss path
   that never blocks a request.
3. **A sick quota database must never 429 or 500 a user.** The limiter fails
   open unconditionally, retains unflushed deltas across failures, and trips a
   circuit breaker (3 consecutive failures → 60s cooldown) that logs loudly
   instead of hammering a degraded database.

**Operator step: there is none.** Moving to Postgres removed the "provision a
dedicated Upstash database and set two env vars" step entirely — the table
ships with the deploy (it is in the terraform-deploy migration allowlist) and
`RATE_LIMIT_ENABLED=true` is the only switch.

### Rate Limit Tiers

**API Access** (programmatic, via API tokens):

| Tier | Per Minute | Per Month | Description |
|------|------------|-----------|-------------|
| `anonymous` | 30 | 500 | Unauthenticated requests (by IP address) |
| `free` | 60 | 1,000 | Authenticated users without paid subscription |
| `paid` | 120 | **10,000** | Users with any active paid subscription |
| `enterprise` | 300 | 50,000 | Enterprise |

> The monthly API figures were tightened from 1,000/2,000 to 500/1,000 in #455
> to discourage scraping; the table now states what the code actually enforces
> (`DefaultConfig` in `services/pkg/ratelimit/config.go` is the source of truth).
> Paid per-minute is a real 120/min ceiling on the *API* column; paid **browser**
> access is genuinely unlimited on both windows.

**Browser Access** (web app, via Firebase auth):

| Tier | Per Minute | Per Month | Description |
|------|------------|-----------|-------------|
| `anonymous` | 60 | 5,000 | Unauthenticated browser requests |
| `free` | 120 | 10,000 | Authenticated without subscription |
| `paid` | **unlimited** | **unlimited** | Paid subscribers have no limits |

The tier table above is the **documented entitlement contract** (it is what the
API docs and pricing page quote). **Both columns are enforced by the Go API**,
after auth, because the edge cannot resolve a caller's subscription tier without
a lookup — and that lookup is exactly the shared dependency that caused the
incident. The edge's tier-blind buckets sit *above* these numbers as an abuse
ceiling, described next.

#### Per-minute enforcement is per instance, and that is deliberate

`minute.go` keeps a fixed-window counter per identifier **in memory, per Cloud
Run instance**, with no shared state. With N instances the effective ceiling is
up to N × the limit (in practice between 1× and N×, since the load balancer
spreads a caller's requests). Accepted, because:

- it is tier **shaping**, not abuse control — the edge's tier-blind bucket is
  the hard ceiling and bounds the worst case regardless;
- the alternative on offer is **zero** per-tier enforcement;
- tiers differ by 2–4×, so an N-fold blur (N is single digits here) does not let
  a free caller reach a paid caller's throughput.

The map is capped (`MinuteMaxIdentifiers`, default 100k) with expired-window
sweeps and least-recently-seen eviction; a full table **fails open** rather than
growing. Unlimited tiers short-circuit with no map entry at all.

A per-minute rejection does **not** consume monthly quota — being throttled
should not also cost you your month.

### Edge enforcement — the tier-blind origin-protection ceiling

The worker cannot resolve a user's paid tier without a database lookup, and
doing one at the edge would reintroduce exactly the coupling that caused the
incident. The edge is therefore deliberately **tier-blind**: it protects the
origin from runaway and abusive traffic. Documented tier per-minute limits are
enforced in-process by the Go API. **Nothing at the edge should ever fire for a
real reader or a paying customer** — if it does, the number is wrong, not the
traffic.

**Two surfaces — but only ONE is actually routed.** The worker script *handles*
two hostnames, and the client IP it would see differs on each: on the browser
route `cf-connecting-ip` is the **real end user**, whereas on the API route
traffic arriving via the Next.js rewrites in `web/next.config.mjs` comes from
**shared Vercel egress IPs** (an anon-IP bucket there would 429 real users en
masse, which is why the first cut shipped with enforcement off).

**However, as verified on 2026-08-23 the zone has exactly one worker route:
`api.shorted.com.au/*` (Terraform).** There is no `shorted.com.au/*` route —
the apex is a plain proxied A record to Vercel, so requests to the frontend
never enter the worker. Everything under `FRONTEND_HOST` in `worker.js`
(`proxyFrontend`, the `browser-anon` / `browser-auth` buckets, browser
`X-RateLimit-Bucket` values) is therefore **dead code today**. That is why
browser traffic records zero 429s — not because the limits are generous.
Adding the route would activate all of it at once, so treat it as a real
rollout with a real blast radius, not a config tweak.

**Two windows per class.** The Cloudflare binding's `period` is a hard enum of
**10 or 60 seconds**, so burst and sustained cannot be one binding — every class
that needs both windows needs two, hence nine bindings. Burst is checked first
so a 429 carries the shorter, more accurate `Retry-After`.

| Surface | Class | Key | Burst (10s) | Sustained (60s) |
|---|---|---|---|---|
| api | authenticated | `k:<sha256(token)[0:32]>` | 100 | 600 |
| api | anonymous | `a:<client IP>` | 10 | 30 |
| api | first-party (SSR/rewrite) | `f:<Vercel egress IP>` | 600 | — |
| browser | anonymous | `ba:<real client IP>` | 100 | 600 |
| browser | signed in | `bu:<sha256(session cookie)[0:32]>` | 200 | 1200 |

- The **browser numbers are measured, not guessed**: Playwright against prod,
  logged out, counting only limitable requests — `/shorts/BHP` costs **9**,
  `/` costs 6, `/top` costs 2. Worst realistic human burst (3-4 stock pages in
  10s) is 27-36; hardest minute (10-15 pages) is 90-135. The defaults sit at
  ~3x and ~4.4x those. **Re-measure before tightening.**
- The **api/authenticated ceiling is not a tier**: the documented paid API tier
  is per-minute *unlimited*, so 600/60s (10 req/s) leaves a legitimate bulk pull
  unimpeded and only catches a runaway or a leaked key.
- The **api/first-party bucket is a runaway detector** — burst-only, keyed by
  egress IP, sized so ordinary ISR regeneration never reaches it. If it fires on
  real traffic, **raise it**.
- **Browser limiting applies ONLY to API-ish paths.** Every HTML document route,
  static asset and Next.js chunk is untouched, and **`/api/auth/*` is exempt on
  both surfaces** — next-auth's session endpoint fires on every page load, so
  limiting it would break sign-in state during ordinary browsing.
- **Verified search crawlers are never limited, anywhere.** SEO is the product;
  a 429 to Googlebot is a crawl-rate penalty that suppresses indexation for
  days. `request.cf.botManagement.verifiedBot` is authoritative, and when Bot
  Management is not populating it the worker takes the SEO-safe error and trusts
  a crawler UA (`edge_rate_limit_trust_crawler_ua = false` to require real
  verification).
- Cloudflare counters are **per-colo and eventually consistent** by design, so
  the effective global ceiling is limit × colos reached. Fine for a ceiling;
  another reason precise monthly quotas stay app-side.
- Both **existing zone bypasses are mirrored in the worker**, each requiring
  **both** the UA marker and the exact secret. E2E testing skips every bucket;
  first-party SSR is *routed* to the first-party bucket rather than skipped.

### First-party identity for rewrite-proxied traffic

This is what unblocked enabling enforcement at all. `next.config.mjs` rewrites
the Connect-RPC paths to `api.shorted.com.au` on purpose (for worker-cache
hits), and that rewrite is performed **by Vercel** — so the worker sees a shared
egress IP, indistinguishable from a scraper.

Next.js rewrites cannot add headers, but **middleware can**: request headers set
via `NextResponse.next({ request: { headers } })` are what the downstream
rewrite forwards. `web/src/middleware.ts` stamps the same marker the SSR fetcher
uses — the `x-shorted-ssr-bypass` secret **and** a user-agent **appended** with
`shorted-web-ssr` (appended, never replaced, so the real client UA survives as a
prefix and crawler identification still works). The worker routes those into the
first-party bucket; the end user is still limited, by their **real** IP, one hop
earlier on the `shorted.com.au` route.

Every edge 429 carries `X-RateLimit-Bucket`, which is the fastest way to confirm
classification in prod: `api-anon` 429s at volume mean the marker is **not**
reaching the worker (check the middleware deploy and the secret).

**We never rate limit ourselves (August 2026).** The secret used to be
load-bearing in the worst way: marker present + secret missing/mismatched fell
through to `api-anon` (10/10s). Between 2026-08-22 and 08-23 that produced
**7,045 zone 429s**, all with UA `shorted-web-ssr/1.0`, all from four Azure IPs
— our **CI-side `vercel build` prerender**, which cannot read Vercel *sensitive*
env vars and so rendered every page unable to prove it was us. ~46% of its API
calls were rejected and fallback data was baked into the static output; nothing
alerted. The rule now:

> A first-party marker we cannot verify routes to the **`first-party` bucket**
> (600/10s) anyway and emits an **unsampled** `edge_bypass_used`
> (`outcome=rejected|unconfigured`). It is never treated as anonymous.

**Identifying the caller takes BOTH layers, and either alone does nothing.**
The worker strips `cf-connecting-ip` and `x-forwarded-for` before forwarding to
the origin (a client-supplied forwarded chain must never survive, or a caller
picks their own bucket) and then re-adds Cloudflare's own value —
`filterRequestHeaders` in `worker.js`. The origin believes those headers only
when the RIGHTMOST forwarded hop is a published Cloudflare address —
`resolveClientIP` in `services/pkg/ratelimit/http.go` — because Cloud Run is
publicly reachable and a direct caller could otherwise forge them. Measured
2026-08-30, the first day limiting ran: with the worker half missing, every
identifier in `api_usage_monthly` was a Cloudflare address, so every caller
behind a colo shared one bucket (30/min for a whole colo at the anonymous
tier). Fixing only the Go side changed nothing for 11 minutes of production
traffic, which is how the worker half was found.

**The app layer now mirrors this, and had to before `RATE_LIMIT_ENABLED` could
be true at all.** `classifyFirstParty` in `services/pkg/ratelimit/interceptor.go`
reads the same marker and the same header (`RATE_LIMIT_SSR_BYPASS_USER_AGENT` /
`_HEADER_NAME` / `_SECRET`, delivered to Cloud Run by the `shorts-api` module)
and yields tier `first-party` or `first-party-unverified`, keyed
`first-party:<egress ip>`. Same rule as the edge: an unverifiable marker is
still first-party. It differs only in what the secret buys — **monthly metering**
(200k unverified vs unmetered verified), never per-minute headroom, so our own
rendering cannot be throttled by a rotation while a spoofed header still cannot
buy unlimited scraping. Both layers must be renamed together.

`resolveRateLimitBypass` returns a third class, `ssr-unverified`, for this. The
secret is an **optimisation** (it lets verified traffic skip the zone rule), not
the thing standing between us and an outage — a rotation, a missed deploy or an
unreadable sensitive var now costs a log line, not our rendering. A spoofed UA
gets 600/10s instead of 10/10s: accepted, because the per-tier and monthly
limits run *after auth* where a UA buys nothing. The **testing** bypass is a
full skip and therefore stays fail-closed.

Corollaries that keep it that way:
- CI-side `vercel build` steps must be handed `SHORTED_SSR_BYPASS_SECRET`
  explicitly (from the Cuttlefish secret `CLOUDFLARE_SSR_BYPASS_SECRET`) — export-only,
  never as `--env`, which would downgrade the sensitive Vercel var.
- `SHORTS_SERVICE_ENDPOINT` must reach every build, or `getServerShortsApiUrl()`
  falls back to the **public** host and the whole prerender crosses Cloudflare
  from one runner IP. (`RELEASE_SHORTS_SERVICE_ENDPOINT` is currently unset —
  see below.)
- Every server-side Connect transport must use `serverFetchWithUserAgent` /
  `serverFetchOutsideNextCache`; enforced by `serverApiSurface.test.ts`.
- `serverFetchWithUserAgent` logs once per process when the secret is missing in
  a Vercel/CI environment, so a build log shows it next time.

**The web middleware's Upstash limiter is gone.** `web/src/@/lib/rate-limit.ts`
stays — API route handlers call it directly — but `middleware.ts` no longer
touches Redis, and its `/api/market-data`, `/api/search` and `/api/community`
matchers (which existed only for that limiter) are removed.

Details, config, bucket rationale, enablement/rollback runbook and what to
watch: `services/edge-worker/README.md`.

### Monthly enforcement — Postgres, batched, fail-open

`AppLimiter` (`services/pkg/ratelimit/monthly.go`) buffers increments in memory
and writes them to **`api_usage_monthly`** (migration 000112) as **ONE
multi-row upsert covering every pending identifier**:

```sql
INSERT INTO api_usage_monthly AS u (identifier, period_month, request_count)
SELECT t.identifier, t.period_month, SUM(t.delta)
FROM unnest($1::text[], $2::date[], $3::bigint[]) AS t(identifier, period_month, delta)
GROUP BY t.identifier, t.period_month
ON CONFLICT (identifier, period_month) DO UPDATE
SET request_count = u.request_count + EXCLUDED.request_count, updated_at = now()
RETURNING identifier, period_month, request_count
```

**Writes** flush when any identifier reaches its batch threshold, when
`MonthlyFlushInterval` elapses, or on **graceful shutdown** (`ShortsServer.Close()`
from `cmd/server/main.go` — SIGTERM is routine on Cloud Run, so this is the
normal path). The upsert is **additive**, never assigned, so concurrent
instances converge rather than clobber.

**Reads** are a cache-miss path, not a lookup. Each identifier's last known
total is cached for `MonthlyTotalTTL` (5m). A miss **allows the request** and
queues an async, 250ms-coalesced `SELECT`. In steady state there are almost no
reads at all, because the flush `RETURNING` clause refreshes the cache for free.

| Knob | Default | Meaning |
|---|---|---|
| `MonthlyFlushThreshold` | **200** | buffered increments for one identifier that trigger a flush of the whole pending set |
| `MonthlyNearLimitThreshold` | **10** | replaces the above once a caller is ≥90% of quota |
| `MonthlyFlushInterval` | **5m** | periodic flush cadence |
| `MonthlyTotalTTL` | **5m** | how long a cached total is trusted |
| `MonthlyMaxIdentifiers` | 50,000 | state-map cap; over-cap callers are unmetered, never rejected |

- **Statement volume**: a flush is one statement regardless of how many
  identifiers or requests it covers, so statement count tracks flush
  *frequency*. Ceiling of 288 periodic flushes/day/instance; at plausible
  traffic (~1–2 req/s, a few hundred authenticated identifiers/day, 2
  instances) that is **~300–600 write statements/day** plus a handful of
  cold-start `SELECT`s. The pre-#455 design issued ~7 Upstash commands per
  request — order 10⁷/day.
- **Overshoot** (effective check = `cached_total + pending_local_delta > limit`):
  a single instance is exact, because its own flush refreshes its own total.
  Across N instances an identifier can exceed quota by at most
  **N × (batch size in effect)** — that is the most any one instance can hold
  unflushed. Far from the limit that is 200N (3 instances = 600, **6%** of a
  10,000/month quota); within 10% of quota the batch collapses to 10, so at the
  boundary that actually matters it is 10N (3 instances = 30, **0.3%**).
  Batching hard is free at 3% of quota and expensive at 97%, so the batch size
  collapses exactly where accuracy starts to matter. The time-based flush adds
  nothing to that bound: if 5 minutes elapsed first, the pending delta was by
  definition smaller. Undercount on instance death is symmetric and identical.
- **Anonymous (IP-keyed) callers are unmetered monthly by default**
  (`SkipAnonymousMonthly`): one row per IP per month is an unbounded key space
  for no enforcement value. Their per-minute window (in process) and the edge
  ceiling still apply. `RATE_LIMIT_SKIP_ANONYMOUS_MONTHLY=false` re-enables it.
- **No request-path I/O and no error path**: `Check` never touches the
  database, so a degraded quota table cannot add latency, 500s, or spurious
  429s. Failed flushes **retain** their deltas (capped) and replay on recovery.

### Response Headers and the 429 payload contract

On a **successful** response the API emits whichever limits it actually owns.
A limit of `0` means "unlimited for this tier" and its headers are **omitted** —
`X-RateLimit-Limit: 0` reads as "you may make zero requests", the opposite of
the truth.

```
X-RateLimit-Limit: 60                  # Per-minute limit (in-process, per tier)
X-RateLimit-Remaining: 41
X-RateLimit-Reset: 1756512000          # unix seconds
X-RateLimit-Monthly-Limit: 10000
X-RateLimit-Monthly-Used: 150
X-RateLimit-Monthly-Remaining: 9850
X-RateLimit-Monthly-Reset: 1709251200  # start of next month
```

**Rejections carry a machine-readable payload.** A 429 that says only "rate
limit exceeded" forces the frontend to guess which limit fired, what the
ceiling was, when it clears, and where to send the user. Every app-layer
rejection (per-minute **or** monthly) is a Connect `resource_exhausted` error
whose metadata carries compact JSON under **`X-RateLimit-Detail`**:

```jsonc
{
  "kind": "per_minute",              // "per_minute" | "monthly"
  "limit": 60,                       // the ceiling that fired
  "used": 60,                        // consumption against it
  "remaining": 0,
  "reset_at": 1756512000,            // unix SECONDS
  "retry_after_seconds": 42,         // matches the Retry-After header
  "tier": "free",                    // anonymous | free | premium | pro | enterprise
  "access": "api",                   // "api" | "browser"
  "upgrade_url": "https://shorted.com.au/pricing",
  "message": "rate limit exceeded: 60 requests per minute. Upgrade at https://shorted.com.au/pricing to raise this limit."
}
```

Go type: `ratelimit.RateLimitDetail` (`services/pkg/ratelimit/quota_error.go`).
**Field names are a contract — renaming one is a breaking change.** The same
facts are mirrored across individual headers (`X-RateLimit-Kind`,
`X-RateLimit-Tier`, `X-RateLimit-Access`, `X-RateLimit-Upgrade-Url`,
`Retry-After`, plus the per-minute/monthly headers above) so a plain `curl` or
a non-Connect client needs no parser.

**`access` is load-bearing for the upgrade copy, not decoration.** Paid
**browser** access is unlimited on both windows; paid **API** access is a real
120/min and 10,000/month ceiling. So "upgrade for unlimited requests" is true
on one surface and a broken promise on the other. `web/src/@/lib/retry.ts`
parses it into `RateLimitInfo.access`, `/rate-limit` accepts it as `?access=`
(that page is deep-linked from the API error body, so it is routinely shown to
API callers), and `rate-limit-notice.tsx` swaps both the CTA and the benefits
list on it. Regression coverage: `rate-limit-access-promise.test.tsx`.

The published tier tables in `api-key-manager.tsx` and `/docs/api` must match
`DefaultConfig` in `services/pkg/ratelimit/config.go` — enforced by
`api-key-manager-quota-contract.test.ts`, which parses the Go file rather than
restating it. They previously over-promised on three rows (anonymous 1,000 vs
an enforced 500, free 2,000 vs 1,000, paid per-minute "Unlimited" vs 120).

`message` is remedy-specific by tier, and the frontend can render it verbatim:
an **anonymous** caller is told *signing in* raises the limit (never "upgrade" —
they have nothing to upgrade); a **free** caller is told to *upgrade at
`upgrade_url`*; a **paid** caller hitting the monthly API cap is told it is a
plan boundary, with no upsell.

`upgrade_url` is absolute (`RATE_LIMIT_UPGRADE_URL`, default
`https://shorted.com.au/pricing` — the canonical upgrade destination, matching
`web/src/@/components/premium/premium-gate.tsx`). It is absolute because the API
is consumed cross-origin and by non-browser clients.

The **edge** 429 is a different, thinner contract — it never sees a tier, so it
carries no `X-RateLimit-Detail`. It sets `X-RateLimit-Limit` / `-Remaining` /
`-Reset` for its own bucket, `Retry-After` (**10** on a burst-bucket rejection,
60 on a sustained one), `X-RateLimit-Scope: edge-10s | edge-60s`, and
`X-RateLimit-Bucket` naming the traffic class that rejected (`api-key`,
`api-anon`, `first-party`, `browser-anon`, `browser-auth`).

An edge 429 body is a Connect error envelope
(`{"code":"resource_exhausted","message":"..."}`) on RPC paths and
`{"error":"Too Many Requests","message":"..."}` elsewhere. Frontends should
branch on the presence of `X-RateLimit-Detail`: present = app-layer (tier
known, actionable), absent = edge (retry after the window).

### Configuration

Environment variables (Go API). **There is no storage configuration** — quota
counters use the API's existing Postgres pool and the table ships with the
deploy, so enabling rate limiting is a single flag:
```bash
RATE_LIMIT_ENABLED=true

# Optional (defaults 200 / 5m / 5m / true / https://shorted.com.au/pricing)
RATE_LIMIT_MONTHLY_FLUSH_THRESHOLD=200
RATE_LIMIT_MONTHLY_FLUSH_INTERVAL=5m
RATE_LIMIT_MONTHLY_TOTAL_TTL=5m
RATE_LIMIT_SKIP_ANONYMOUS_MONTHLY=true
RATE_LIMIT_UPGRADE_URL=https://shorted.com.au/pricing
```

**Migration landmine**: prod does not run `migrate up`. `000112_add_api_usage_monthly`
is in the hardcoded allowlist in `.github/workflows/terraform-deploy.yml` and is
**replayed on every deploy**, which is why every statement in it is
`IF NOT EXISTS` and it touches no rows. It sits *before* `000095` so the
hardened `refresh_all_materialized_views()` definition still applies last.
Regression coverage: `node --test services/migrations/api_usage_monthly.test.mjs`.

Edge worker config is Terraform-owned (`edge_rate_limit_*` variables in
`terraform/modules/cloudflare-edge/variables.tf`) — **not** `wrangler.toml`,
which exists only for local dev parity. See the worker README.

### Cloudflare Edge Test Bypass

The Cloudflare **zone** rate limit is separate from the worker buckets and the app's monthly quota. It can be bypassed for trusted E2E/load testing, but only with both a user-agent marker and a secret header. **The edge worker mirrors this same bypass** (`resolveRateLimitBypass` in `worker.js`) — if you change the UA/header/secret here, change it there too, or trusted traffic will clear the zone rule and then be caught by the worker bucket.

Setup:
```bash
cd terraform/environments/prod
export TF_VAR_rate_limit_testing_bypass_secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
terraform plan
terraform apply
```

Use:
```bash
curl \
  -H "User-Agent: Shorted-E2E/1.0" \
  -H "X-Shorted-Testing-Bypass: $TF_VAR_rate_limit_testing_bypass_secret" \
  https://api.shorted.com.au/health
```

Defaults live in `terraform/modules/cloudflare-edge/variables.tf`:
- `rate_limit_testing_bypass_secret = ""` disables the bypass.
- `rate_limit_testing_bypass_header_name = "x-shorted-testing-bypass"`.
- `rate_limit_testing_bypass_user_agent = "Shorted-E2E"`.

The secret is embedded in the Cloudflare rule/Terraform state. Keep it out of tracked tfvars and rotate it if it leaks. Regression coverage: `node --test terraform/modules/cloudflare-edge/rate-limit-expression.test.mjs`.

Browser tests send it to our own origins and localhost only: specs import
`test` from `web/e2e/helpers/test.ts` (`testing-bypass-scope.mjs` holds the
list), and release smoke uses `scoped-release-headers.mjs`. Never put it in
Playwright's `extraHTTPHeaders`, here or in a scratch script: those go to every
host a page contacts, and a stock page contacts Google (Analytics, Tag Manager,
the logo bucket) and Cloudflare's beacon. Until 2026-10-14 the shared config did
exactly that, so every e2e run with the secret set sent it to them.

### Cloudflare SSR Bypass (first-party Vercel SSR)

Same shape as the test bypass, but for **our own** SSR fetcher. Vercel egress
shares a handful of IPs per region, so ISR regenerations and warm-cache bursts
blow the 60 req/10s per-IP zone limit and get 429'd (measured on prod
2026-08-20: hundreds of blocked requests/day, including `GetTopShorts` during
`/top` regens). A request is exempted only when it carries **both** the
`shorted-web-ssr` user-agent marker **and** the exact secret header — never
UA-only.

Terraform (`terraform/modules/cloudflare-edge/variables.tf`):
- `rate_limit_ssr_bypass_secret = ""` disables it (the rule expression collapses to a literal `false`).
- `rate_limit_ssr_bypass_header_name = "x-shorted-ssr-bypass"`.
- `rate_limit_ssr_bypass_user_agent = "shorted-web-ssr"`.

These three values are also delivered to the **edge worker** (as
`RATE_LIMIT_SSR_BYPASS_{SECRET,HEADER_NAME,USER_AGENT}` bindings) so the
worker's per-minute buckets exempt the same traffic the zone rule exempts. An
unset secret disables the bypass in both places identically.

The deploy passes it as `TF_VAR_rate_limit_ssr_bypass_secret` from the Cuttlefish
project secret `CLOUDFLARE_SSR_BYPASS_SECRET` (terraform-deploy.yml plan + apply).
The GitHub repo copy of the same name feeds only `rate-limit-sentinel.yml`, which
probes with it on a GitHub-hosted runner.

Web side: `web/src/app/actions/config.ts` attaches
`X-Shorted-Ssr-Bypass: $SHORTED_SSR_BYPASS_SECRET` in
`serverFetchWithUserAgent` **only** when that server-only env var is non-empty
**and** the request targets a shorted API origin (`api.shorted.com.au` or the
configured `SHORTS_SERVICE_ENDPOINT`/`SHORTS_API_URL`/`SHORTED_EDGE_API_URL`
host). It is **never** `NEXT_PUBLIC_*` and must never reach a client bundle or
a third-party host.

Mint + rotate (all four must be updated together — Cloudflare rule, the Cuttlefish
copy the deploy reads, the GitHub copy the sentinel reads, Vercel):
```bash
SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
# The Cuttlefish copy is the one the deploy reads. Updating only the GitHub copy
# leaves the deploy on the old value.
printf '%s' "$SECRET" | cuttle secrets set CLOUDFLARE_SSR_BYPASS_SECRET --project shorted
printf '%s' "$SECRET" | gh secret set CLOUDFLARE_SSR_BYPASS_SECRET --repo castlemilk/shorted.com.au
printf '%s' "$SECRET" | vercel env add SHORTED_SSR_BYPASS_SECRET production
# then re-run terraform-deploy (or: cd terraform/environments/prod &&
# TF_VAR_rate_limit_ssr_bypass_secret="$SECRET" terraform apply)
```
Rotation order: set the new value in Terraform/Cloudflare first, then Vercel —
the old header simply stops matching, so the worst case is a brief window of
rate-limited SSR, never an outage. Rotate immediately if the secret appears in
a client bundle, a log, or a tracked tfvars file.

### Cost Attribution Observability

Cloudflare RUM should use Cloudflare automatic Web Analytics injection for proxied production hostnames (`shorted.com.au`, `www.shorted.com.au`); Terraform manages the zone RUM switch via `cloudflare_zone_setting.web_analytics_rum`. The app component `web/src/@/components/cloudflare-web-analytics.tsx` is a disabled-by-default app-managed fallback and only renders when `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED=1` plus a hostname-correct `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` are set. The fallback must use `data-cf-beacon` with `send: { to: "/cdn-cgi/rum" }` so browser beacons post to the same-origin Cloudflare endpoint, not `cloudflareinsights.com/cdn-cgi/rum`. Cost attribution joins Cloudflare RUM page views with Worker `edge_request`, Firestore `firestore_operation`, product funnel `product_event`, and backend AI `cost_event` JSON logs. Query examples and field contracts live in `docs/observability/cost-attribution.md`.

For production incident triage, use `$shorted-prod-troubleshooting` to combine RUM/analytics with Vercel logs, Worker versions, release-smoke results, API edge checks, and database verification.

### Key Files

| File | Purpose |
|------|---------|
| `services/edge-worker/worker.js` | **Per-minute** rate limiting (Cloudflare bindings) |
| `services/edge-worker/README.md` | Edge rate limiting design, config, rollout |
| `services/edge-worker/ratelimit.test.mjs` | Edge rate limiting tests (`node --test`) |
| `terraform/modules/cloudflare-edge/main.tf` | Worker script + `ratelimit` bindings (worker deploy is Terraform, not wrangler) |
| `services/pkg/ratelimit/monthly.go` | **Monthly** quota accounting: batching + circuit breaker |
| `services/pkg/ratelimit/config.go` | Tier configuration + batching defaults |
| `services/pkg/ratelimit/interceptor.go` | Connect interceptor + header contract |
| `services/shorts/.../middleware_connect.go` | Auth + subscription lookup |
| `services/migrations/000015_add_api_subscriptions.up.sql` | Subscription table |

