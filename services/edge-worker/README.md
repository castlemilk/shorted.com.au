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

### Forwarding the caller's address to the origin (do not "clean this up")

The origin cannot meter a caller it cannot see, and this worker is what decides
whether it can. Two functions carry that responsibility, and both look like
header hygiene:

- **`filterRequestHeaders`** strips `cf-connecting-ip` and `x-forwarded-for`
  **first**, then re-adds Cloudflare's own `cf-connecting-ip`. The ordering is
  the security property: an inbound `x-forwarded-for` is attacker-controlled and
  must never survive, or a caller picks their own rate-limit bucket by sending a
  header. What we forward is Cloudflare's value, which Cloudflare overwrites on
  the inbound request and a client cannot spoof through it. A **single** address
  is forwarded, never a chain — the origin takes the rightmost hop, and appending
  to a client-supplied list hands back the control the strip just removed.

- **`buildPublicEdgeReadHeaders`** (`/edge/v1/*`) does not proxy the caller's
  request at all; it builds a **new** one, so it has to copy the address forward
  explicitly. It also copies the user-agent — which carries the `shorted-web-ssr`
  marker — so it must copy the bypass secret with it. A marker without its proof
  *is* `first-party-unverified`: our own traffic, recognised as ours, and metered
  for want of one header.

  Minimal headers here are deliberate: that response is **cached and served to
  other people**, so cookies and `Authorization` must not ride along. "Just
  forward everything" is the obvious wrong fix and there are tests against it.

Neither is optional, and neither is sufficient. The origin half is
`resolveClientIP` in `services/pkg/ratelimit/http.go`, which believes these
headers **only** when the rightmost forwarded hop is a published Cloudflare
address — because Cloud Run is publicly reachable and a direct caller could
otherwise forge them.

**Measured on 2026-08-30/31**, the first days app-layer limiting ran: with any
one of the three layers missing, every identifier written to `api_usage_monthly`
was a Cloudflare address, so every caller behind a colo shared one bucket
(30/min for a whole colo at the anonymous tier). Two consecutive fixes deployed
cleanly and changed nothing, because each was blocked by a different layer.

Full picture and the debugging runbook: `docs/rate-limiting.md`.

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

#### An unverified first-party claim fails OPEN (August 2026)

The secret used to be load-bearing in the worst way: a request that carried the
`shorted-web-ssr` marker but *not* a matching secret fell through to `api-anon`
— **10 requests / 10s**. That is fail-CLOSED for our own traffic, and it fired.

Between 2026-08-22 and 2026-08-23 the zone returned **7,045 HTTP 429s**, every
one of them to a caller with user-agent `shorted-web-ssr/1.0`, from four
Microsoft/Azure IPs (GitHub Actions egress) — our own **CI-side `vercel build`
prerender**. `vercel build` runs on the runner and **cannot read Vercel's
SENSITIVE environment variables**, and `SHORTED_SSR_BYPASS_SECRET` is one, so
every production build rendered every page as an unverifiable first-party
caller, got ~46% of its API calls rejected, and baked fallback data into the
static output. Nothing alerted; it was found by hand-querying Cloudflare GraphQL.

So the rule is now:

> **A first-party marker we cannot verify is routed to the `first-party`
> bucket anyway (600/10s) and emits a loud, unsampled event. It is never
> treated as anonymous.**

`resolveRateLimitBypass` returns a third class, `ssr-unverified`, for exactly
this case. The secret keeps its real job — letting *verified* traffic skip the
zone rule outright — but it is an **optimisation**, never the thing standing
between us and an outage. A rotation, a missed deploy, a stale value or an
unreadable sensitive var can now cost us a skipped optimisation and a noisy log
line, not our own rendering.

**The tradeoff, stated plainly:** a user-agent is spoofable, so a scraper that
sends `shorted-web-ssr` now gets 600/10s instead of 10/10s. Accepted. 600/10s is
still a hard runaway ceiling, the app-layer per-tier limits and monthly quota
run *after auth* where a spoofed UA buys nothing, and the WAF/DDoS layers are
untouched. Rate-limiting our own renderer is a self-inflicted outage; giving a
spoofer a higher abuse ceiling is a cost. Those are not comparable.

Note the asymmetry with the **testing** bypass, which is a full skip and
therefore stays fail-closed: an unset testing secret can never be spoofed into
unlimited access.

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
| First-party, **unverified** (`ssr-unverified`) | `shorted-web-ssr` | absent / wrong | **still** routed to the first-party bucket + unsampled `edge_bypass_used` |

For the **testing** class both the UA marker and the exact secret are required —
never the UA alone, and an empty secret disables the class entirely, because it
grants a full skip. The **first-party** class is deliberately different: the
secret decides whether the request also skips the *zone* rule, but the UA marker
alone is enough to keep it out of the anonymous bucket (see above).

### Failure behaviour

The limiter fails **open** in every ambiguous case: missing binding, throwing
binding, malformed outcome, unknown class, ineligible path — and enforcement is
**opt-in**: anything other than `EDGE_RATE_LIMIT_ENABLED=true` (including the
flag being absent) disables it. Rate limiting must never be the reason the site
or API is down.

### Observability

The Cloudflare rate limiting bindings expose **no analytics of their own**, and
a 429 leaves no trace beyond the response. So every decision the worker makes
emits a `type: "edge_rate_limit"` JSON line (`recordRateLimitDecision`), and
`edge_request` gained two additive fields (`rate_limited`, `rate_limit_bucket`)
so the existing stream can tell an edge 429 from an app-layer or zone 429.

**The sampling is asymmetric on purpose.** `limited` decisions are emitted at
**100%**, always — a 429 is rare and high-signal, and at the 1% analytics rate a
bucket firing a dozen times a day would show as nothing at all. `allowed`
decisions are sampled (`EDGE_RATE_LIMIT_SAMPLE_RATE`, inheriting
`EDGE_ANALYTICS_SAMPLE_RATE`, default 1%). Every event carries the `sample_rate`
that produced it, so **any ratio query must divide each arm by its own rate**.

The bucket **key** (token hash, session hash, or IP) is never emitted in any
form; only `key_type` (`token-hash` | `ip` | `session-hash`). Bypass secrets are
never emitted, only the matched class name. Paths are normalized.

An **optional** Analytics Engine `writeDataPoint` path exists for aggregate
queries ("429s by bucket over 7 days"). It is off unless
`edge_rate_limit_analytics_dataset` is set; with no binding the worker no-ops
and the JSON line remains the source of truth.

Field contract, the positional Analytics Engine schema, six worked operator
queries (including "is the first-party marker landing?", which cannot be tested
from outside), and what an operator must enable to run them (no Logpush job is
configured today): **`docs/observability/cost-attribution.md`**. Regression
coverage: `services/edge-worker/ratelimit-observability.test.mjs`.

## Edge health events

Beyond `edge_request` and `edge_rate_limit`, the worker emits six event types
covering everything else that used to be invisible. Full field contracts,
positional Analytics Engine schema and eleven worked operator queries live in
**`docs/observability/cost-attribution.md`**; regression coverage is
`services/edge-worker/events.test.mjs`.

| Event | Sampling | The question it answers |
|---|---|---|
| `edge_origin_error` | **100%** | Is the origin healthy right now? Origin 5xx/3xx/1xx, fetch throws and timeouts, by bounded `origin` and `error_class`. Previously invisible — an outage showed only as user-facing errors. **4xx is deliberately excluded**: the origin working is not an incident. |
| `edge_upstream_latency` | sampled (`edge_upstream_latency_sample_rate`) | Which RPCs are slow, and is caching helping? Six-value `duration_bucket` × `cache_status` × `rpc_method`. Bucketed so it is a group-by dimension in Analytics Engine, which has no percentile functions. |
| `edge_config` | **once per isolate** | Did the config I just deployed actually land? A snapshot of what this running copy *reads*: `deploy_id` (a hash of the deployed `worker.js`), every bucket limit **and whether its binding is actually bound**, sample rates, secret presence booleans, origin hostnames, TTLs. |
| `edge_bypass_used` | **100%** for `testing`, and for any `rejected`/`unconfigured` (capped 20/isolate/minute with a `suppressed` counter); sampled for routine accepted `ssr` | Has a bypass secret leaked, is someone probing, **or did our own secret stop matching?** Emitted from the top of `fetch`, so it fires even when rate limiting is disabled or the path is ineligible — the case where `edge_rate_limit` emits nothing at all. `outcome=rejected`/`unconfigured` on `bypass_class=ssr` is now the single alarm for "first-party identity is broken"; it is unsampled precisely because the August 2026 incident hid inside a 1% sample. |
| `edge_kv_error` | **100%**, capped at 20/isolate/minute with a `suppressed` counter | Is KV degraded, and what is it costing? KV faults were swallowed in four places; the outage silently turned every cacheable request into an origin fetch. |
| `edge_cache_purge` | **100%** | Did the purge land? A failed purge means stale data for up to the 24h KV TTL, previously recorded only in an HTTP response body nobody reads. `unauthorized` is a probe signal — the purge secret travels in the request body. |

**One rule governs all of them: rare and actionable is 100%, routine and
high-volume is sampled.** Sampling a rare event at 1% does not reduce cost
meaningfully, it makes the alarm invisible. Because rates differ *between arms
of the same event type*, every event carries the `sample_rate` that produced it
and any query mixing arms must divide each side by its own rate.

Every emitter is a void function wholly inside a `try/catch`, is never awaited
by the request path, and emits only bounded vocabularies — no raw paths, no
query strings, no credentials, no IPs, and **no raw error messages** (a Workers
`TypeError` can embed a request URL, and that URL can carry a token; errors are
classified into `timeout` / `aborted` / `network` / `internal` and the message
is discarded). Tests grep serialized events for the real secret values.

### The deploy check

```bash
# What did I just deploy?
shasum -a 256 services/edge-worker/worker.js | cut -c1-12

# What does the running worker say it is?
wrangler tail shorted-edge-cache --format=json \
  | jq -r 'select(.logs[]?.message[0]? | fromjson? | .type == "edge_config")'
```

Terraform sets `EDGE_DEPLOY_ID` from the **same** `file()` call that produces the
uploaded script, so it cannot drift from what was deployed. Mismatch = the
script did not upload. Two ids for more than ~15 minutes = a colo is pinned to
the old script. `rate_limit_enabled: true` with any `burst_bound: false` =
enforcement is believed on and silently doing nothing.

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
| `edge_rate_limit_sample_rate` | `-1` (inherit `edge_analytics_sample_rate`) | Sample rate for **allowed** `edge_rate_limit` events only |
| `edge_rate_limit_analytics_dataset` | `""` (binding not attached) | Analytics Engine dataset for rate limit data points |
| `edge_upstream_latency_sample_rate` | `-1` (inherit) | Sample rate for `edge_upstream_latency` |
| `edge_bypass_sample_rate` | `-1` (inherit) | Sample rate for the **routine (accepted SSR)** arm of `edge_bypass_used` only |
| `edge_events_analytics_dataset` | `""` (binding not attached) | Analytics Engine dataset for `edge_origin_error` + `edge_upstream_latency` |

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
- **`edge_bypass_used` with `bypass_class=ssr` and `outcome != accepted`** —
  the direct alarm for a broken/rotated/undelivered SSR secret. Unsampled, so
  any volume here is real volume. Since August 2026 this no longer causes 429s
  (unverified first-party is bucketed generously), which means this event is
  the **only** way you will hear about it — treat a non-zero rate as a page.
- **`clientRequestHTTPHost = api.shorted.com.au` with UA `shorted-web-ssr` from
  a non-Vercel ASN** — that is a build machine, not a Vercel function. Vercel
  runtime egress is AWS (ASN 16509, ap-southeast-2); GitHub Actions is Microsoft
  (ASN 8075, US). A build talking to the *public* host instead of the Cloud Run
  origin means the endpoint env var did not reach the build.
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
