# Rate limiting

How a caller is identified, which class they land in, what they should expect,
and how to find out why they got a 429 — or why they did not.

Companion docs:

- `services/edge-worker/README.md` — the edge layer in depth (buckets, windows,
  bypasses, rollout).
- `CLAUDE.md` → *Rate Limiting* — the landmines, kept short on purpose.

Source of truth for every number below is `services/pkg/ratelimit/config.go`
(`DefaultConfig`). If this document and that file disagree, the file is right and
this document is a bug. `api-key-manager-quota-contract.test.ts` parses the Go
file rather than restating it, for exactly that reason.

---

## 1. The short version

Three layers, three different jobs, three different failure domains:

| Concern | Where it runs | Depends on |
|---|---|---|
| Tier-blind **abuse ceiling** | Cloudflare edge worker | Cloudflare only |
| **Per-tier per-minute** shaping | Go API, in process, per instance | nothing |
| **Monthly quota** accounting | Go API | Postgres (`api_usage_monthly`) |

Two properties worth internalising before debugging anything:

- **A reader on the website cannot be rejected by the app layer.** Not by a
  per-minute ceiling, not by a monthly quota. If a browser user is getting 429s,
  it is the edge or the zone rule, not this.
- **The limiter fails open, unconditionally.** A sick quota database never
  rejects anyone; it silently stops enforcing. So "no 429s" is not evidence that
  quota accounting is working — see §6.4.

---

## 2. Caller classes

The class is chosen in `extractIdentifierAndTier`
(`services/pkg/ratelimit/interceptor.go`), in this order. First match wins.

| # | Class | Identifier | When |
|---|---|---|---|
| 1 | authenticated user | `user:<uid>` | request carries verified claims |
| 2 | first-party (verified) | `first-party:<egress ip>` | SSR marker **+** matching secret |
| 3 | first-party (unverified) | `first-party:<egress ip>` | SSR marker, secret missing/wrong |
| 4 | anonymous | `ip:<addr>` | none of the above |

Two surfaces have their own identity functions, because they bypass the Connect
interceptor entirely:

| Class | Identifier | Where |
|---|---|---|
| MCP, OAuth token | `oauth:<uid>` | `mcp/ratelimit.go` |
| MCP, opaque bearer | `token:<sha256[:32]>` | `mcp/ratelimit.go` |
| MCP, anonymous | `mcp-anon:<ip>` | `mcp/ratelimit.go` |

### 2.1 What each class gets

**API access** (programmatic — an API token, or no credential at all):

| Tier | Per minute | Per month |
|---|---|---|
| `anonymous` | 30 | 500 |
| `free` | 60 | 1,000 |
| `pro` / `premium` | 120 | 10,000 |
| `enterprise` | 300 | 50,000 |

**Browser access** (a signed-in user on the website):

| Tier | Per minute | Per month |
|---|---|---|
| `anonymous` | 60 | 5,000 |
| `free` | 120 | 10,000 |
| paid | unlimited | unlimited |

**First-party** — our own traffic. Not a customer tier, never sold:

| Class | Per minute | Per month |
|---|---|---|
| `first-party` | **unlimited** | **unmetered** |
| `first-party-unverified` | **unlimited** | 200,000 |

### 2.2 Why first-party is per-minute unlimited

It is not generosity. This class carries our own SSR **and every anonymous
browser RPC** — `web/src/middleware.ts` stamps the marker on rewrite-proxied
paths — all keyed by a handful of shared Vercel egress addresses.

A per-minute rejection there does not throttle one caller. It fails *every
reader behind that address at the same instant*. The previous 3000/min sat about
5x the measured zone peak of 612/min: adequate, and shrinking with every good
week of traffic, for a limit whose only function was to duplicate a ceiling the
edge already enforces at 600/10s.

The **unverified** class is unlimited per-minute for a different reason: if it
were finite, a secret rotation gap would move all of our own traffic into a
finite bucket and 429 the site — turning a credential-delivery problem into an
outage. The rule is that the secret costs a **meter**, never a rejection.

What bounds a spoofer is therefore the edge bucket plus the 200k monthly meter,
not the per-minute number.

### 2.3 The counter-intuitive one

**Ordinary browsing carries no auth token.** There is no auth interceptor on the
client transport (`web/src/@/lib/client-api.ts` builds a bare
`createConnectTransport`), so page views — signed in or not — land in
**first-party**, not on a user identity.

Consequences, both of which surprise people:

- The published free-tier browser cap (120/min, 10,000/month) is **not reachable
  by browsing**. Only authenticated feature calls (chat, watchlist) touch it.
  Real signed-in users measure ~2 requests each against 10,000.
- Anonymous and signed-in readers share the same class and the same ceiling.

---

## 3. Who is the caller? The identity chain

Resolving a caller's address takes **three** layers. Any one alone does nothing,
which is how a fix can look correct and change nothing in production.

```
browser ──▶ Cloudflare ──▶ Google front end ──▶ Cloud Run
                │                                    │
       worker forwards the                  origin decides whether
       true client address                  to believe it
```

1. **`buildPublicEdgeReadHeaders`** (`worker.js`) — `/edge/v1/*` builds a *new*
   Request from scratch, so it must copy the client address forward explicitly.
   It also copies the user-agent, which carries the SSR marker, so it must copy
   the bypass secret with it. A marker without its proof *is*
   `first-party-unverified`.
2. **`filterRequestHeaders`** (`worker.js`) — strips client-supplied hops
   **first** (that ordering is the security property; an inbound
   `X-Forwarded-For` is attacker-controlled), then re-adds Cloudflare's own
   `cf-connecting-ip`.
3. **`resolveClientIP`** (`services/pkg/ratelimit/http.go`) — rightmost
   `X-Forwarded-For` by default, because a proxy *appends* and the last entry is
   the only hop a client could not have written. **Exception:** when the
   rightmost hop is a published Cloudflare address, the request demonstrably came
   through our edge, so `CF-Connecting-IP` can be believed.

The exception exists because Cloudflare rewrites the *leftmost* entry with the
true client and Google appends Cloudflare's own address — so the plain rightmost
rule always yields our edge. The guard exists because Cloud Run is publicly
reachable (`allUsers` invoker, no ingress restriction), so a direct caller could
otherwise forge `CF-Connecting-IP` and choose their own bucket.

`extractIP` (Connect) and `ClientIP` (plain HTTP) both delegate to
`resolveClientIP`. They were separate implementations until 2026-08-30, and the
Connect one carries most of the traffic.

---

## 4. What a caller sees

### 4.1 On success

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 41
X-RateLimit-Reset: 1756512000
X-RateLimit-Monthly-Limit: 10000
X-RateLimit-Monthly-Used: 150
X-RateLimit-Monthly-Remaining: 9850
X-RateLimit-Monthly-Reset: 1709251200
```

**A limit of 0 means unlimited, and its headers are omitted.** `X-RateLimit-Limit: 0`
would read as "you may make zero requests". So *absence of a header is the
unlimited signal*, not a fault — this trips up monitoring, see §6.2.

### 4.2 On rejection

App-layer rejections carry `X-RateLimit-Detail`, compact JSON:

```jsonc
{
  "kind": "per_minute",        // "per_minute" | "monthly"
  "limit": 60, "used": 60, "remaining": 0,
  "reset_at": 1756512000,
  "retry_after_seconds": 42,
  "tier": "free",
  "access": "api",             // "api" | "browser"
  "upgrade_url": "https://shorted.com.au/pricing",
  "message": "..."
}
```

Field names are a contract (`ratelimit.RateLimitDetail`); renaming one is
breaking. `access` decides the upgrade copy — paid **browser** is unlimited while
paid **API** is a real ceiling, so "upgrade for unlimited" is true on one surface
and a broken promise on the other.

**Edge rejections carry no `X-RateLimit-Detail`.** They carry
`X-RateLimit-Bucket` naming the class instead. That presence/absence is the
fastest way to tell the two layers apart — see §6.5.

### 4.3 MCP is different on purpose

An **anonymous** MCP caller at their ceiling gets **401** with an RFC 9728
`WWW-Authenticate` challenge, not 429. MCP clients begin OAuth discovery on the
*status*; a 429 is a transport failure to all of them, so the body's "authenticate
to raise this" would be unactionable. An **authenticated** caller gets a plain
429 — they have already done what a challenge asks; what they need is
`upgrade_url`.

First contact is never challenged. That is the adoption path, and it must stay
free.

---

## 5. What "normal" looks like

Readings from healthy production, so you can tell drift from breakage:

```
anonymous                x-ratelimit-limit: 30
first-party (no secret)  no per-minute header; x-ratelimit-monthly-limit: 200000
via the website          no rate-limit headers at all
MCP initialize           200, no WWW-Authenticate
```

Cost, measured over 15.4h of real traffic via `pg_stat_statements`:

| statement | calls | total DB time |
|---|---|---|
| flush upsert | 215 | 1,711 ms |
| cold-start read | 193 | 54 ms |

**~640 statements/day, 1.8 seconds of database time.** 9,338 metered requests
produced 215 writes (~43 requests per statement). If you are looking at these
numbers wondering whether to optimise them: no. See §8.

---

## 6. Investigating

### 6.1 Is enforcement even on?

```bash
curl -sS -o /dev/null -D - -X POST \
  "https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetTopShorts" \
  -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" \
  -H "User-Agent: Mozilla/5.0 (Macintosh) Chrome/140" \
  -d '{"period":"3m","limit":1}' | grep -i x-ratelimit
```

Expect `x-ratelimit-limit: 30`. No headers at all on an *anonymous* request means
the limiter is off — check `rate_limit_enabled` in
`terraform/environments/prod/main.tf` and `RATE_LIMIT_ENABLED` on the service.

A browser-ish UA is required: `api.shorted.com.au` fingerprints clients and
refuses a bare agent before it reaches the origin. A 403 here is Cloudflare, not
an outage.

### 6.2 Which class am I in?

```bash
# with the marker, no secret -> first-party-unverified
curl ... -H "User-Agent: Mozilla/5.0 Chrome/140 shorted-web-ssr/1.0"
```

| What you see | Class |
|---|---|
| no per-minute header, `monthly-limit: 200000` | first-party, unverified |
| no rate-limit headers at all | first-party, verified (or a paid browser user) |
| `limit: 30` | anonymous — **if this happens with the marker, that is the bug** |

**Absence of a per-minute header is healthy.** It means unlimited. Do not read it
as "cannot tell".

### 6.3 Who is actually being metered?

This is the question that matters when limits fire on the wrong people, and the
only reliable answer is the table:

```sql
SELECT identifier, request_count FROM api_usage_monthly ORDER BY request_count DESC LIMIT 20;
```

**Every identifier being a Cloudflare address** (`104.22.x`, `172.69.x`,
`162.158.x`, `108.162.x`) means the identity chain in §3 is broken and callers
behind a colo are sharing a bucket. That was live on 2026-08-30.

To tell whether a fix worked, **a deploy succeeding proves nothing.** Snapshot,
wait one flush cycle, diff:

```bash
psql -c "SELECT identifier, request_count FROM api_usage_monthly ORDER BY identifier" > before.txt
sleep 330   # one MonthlyFlushInterval, plus slack
psql -c "SELECT identifier, request_count FROM api_usage_monthly ORDER BY identifier" > after.txt
diff before.txt after.txt
```

Then classify what *grew*: Cloudflare-keyed or real client addresses. This method
caught two fixes that had deployed cleanly and changed nothing.

**Ground truth for one request:** send the marker with a *deliberately wrong*
secret. That forces the unverified class, which is metered, so a row appears —
and it should be keyed to your own address:

```bash
curl ... -H "User-Agent: ... shorted-web-ssr/1.0" -H "x-shorted-ssr-bypass: deliberately-wrong"
# wait a flush cycle, then look for your own IP in api_usage_monthly
```

Note that **verified first-party writes no rows at all** (unmetered). So "rows
stopped appearing" is a success signal, not a failure one.

### 6.4 Is quota accounting healthy?

The limiter fails open, so degradation is invisible from responses.

```bash
curl -sS "https://api.shorted.com.au/api/admin/rate-limit-health" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_SECRET" \
  -H "User-Agent: Mozilla/5.0 (Macintosh) Chrome/140"
```

```jsonc
{ "enabled": true,
  "health": { "degraded": false, "retained_deltas": 0,
              "tracked_identifiers": 120, "max_identifiers": 50000 } }
```

- `degraded: true` — the circuit breaker is open; `api_usage_monthly` writes are
  failing and **monthly quotas are not being enforced**. Requests are unaffected.
  Look at Supabase; deltas are retained and replay on recovery.
- `retained_deltas` climbing — the durable-loss signal. A flush-failure counter
  resets on recovery; this keeps climbing, and says how much quota disappears if
  the instance is replaced.
- `tracked_identifiers` near `max_identifiers` — at the cap, new callers go
  **unmetered** rather than rejected. Enforcement degrades silently.

### 6.5 Edge 429 or app 429?

Branch on `X-RateLimit-Detail`:

- **present** → app layer. Tier is known, the payload is actionable.
- **absent** → edge. Read `X-RateLimit-Bucket` (`api-key`, `api-anon`,
  `first-party`, `browser-anon`, `browser-auth`) and `X-RateLimit-Scope`
  (`edge-10s` / `edge-60s`).
- **neither, at very high concurrency** → the Cloudflare *zone* rule, which fires
  ahead of the worker and carries no bucket header. Do not mistake it for a
  worker bucket.

`api-anon` 429s at volume mean the first-party marker is not reaching the
worker — check the middleware deploy and the secret.

### 6.6 Symptom → cause

| Symptom | Likely cause |
|---|---|
| Readers getting 429s | Not the app layer — it cannot reject them. Check the edge bucket and zone rule. |
| Every identifier is a Cloudflare address | Identity chain broken (§3). Check all three layers. |
| `first-party` rows accumulating | Something carries the marker without the secret. §3 step 1 is the usual culprit. |
| Our own traffic metered as `anonymous` | The marker is not arriving. Compare `worker.js` and `interceptor.go` — they must use the same strings. |
| No `X-RateLimit-*` on an anonymous request | Limiter off. |
| No headers on a *first-party* request | Healthy. Unlimited. |
| 403, not 429 | Cloudflare bot fingerprinting. Use a browser UA. |

---

## 7. Monitoring

`.github/workflows/rate-limit-sentinel.{yml,mjs,test.mjs}` runs daily and files
(and closes) a GitHub issue. It checks that enforcement is on, that our own
marker is not metered as anonymous, that anonymous MCP first contact is free,
and — with `INTERNAL_SERVICE_SECRET` — the health endpoint above.

Without the secret it runs the first three checks and says so, rather than
failing: a partial sentinel beats one that refuses to start.

It exists because **every failure mode here is silent**, and all of it was
already in Grafana — as was the August 2026 edge failure that produced 7,045
self-inflicted 429s over two days with nothing alerting. Metrics nobody watches
are not monitoring.

Run it by hand:

```bash
INTERNAL_SERVICE_SECRET=... SHORTED_SSR_BYPASS_SECRET=... \
  node .github/workflows/rate-limit-sentinel.mjs
```

---

## 8. Things that look like problems and are not

- **~640 Postgres statements/day.** Measured 1.8 seconds of DB time per 15 hours.
  There is nothing to optimise. `MonthlyTotalTTL` equalling `MonthlyFlushInterval`
  does cause some redundant reads — worth 54ms per 15 hours, and not worth
  trading durability for.
- **Per-minute limits are per Cloud Run instance.** With N instances the
  effective ceiling is up to N×. Accepted: this layer is tier *shaping*, the edge
  is the hard ceiling, and tiers differ by 2–4× so a free caller still cannot
  reach paid throughput.
- **Anonymous callers are unmetered monthly** by default
  (`SkipAnonymousMonthly`) — one row per IP per month is an unbounded key space
  for no enforcement value. MCP anonymous *is* metered (`mcp-anon:` does not
  match the `ip:` prefix), which is deliberate: it is what makes the 401
  challenge reachable on a human timescale.
- **Upstash is not used for the Go API's limiter, on purpose.** 437k metered
  requests/month is a *lower* bound (anonymous and verified first-party write no
  rows) against a 500k/month cap **shared with the page cache**, and
  `@upstash/ratelimit`'s sliding window costs ~7 commands per request → ~3.06M.
  That shared quota is what turned one exhaustion into two outages.
  `web/src/@/lib/rate-limit.ts` *is* Upstash-backed for ~8 low-volume Next.js
  route handlers; the prohibition is specific to the Go API.

---

## 9. Configuration and rollback

```bash
RATE_LIMIT_ENABLED=true          # the only switch; there is no storage to configure

# Optional (defaults shown)
RATE_LIMIT_MONTHLY_FLUSH_THRESHOLD=200
RATE_LIMIT_MONTHLY_FLUSH_INTERVAL=5m
RATE_LIMIT_MONTHLY_TOTAL_TTL=5m
RATE_LIMIT_SKIP_ANONYMOUS_MONTHLY=true
RATE_LIMIT_UPGRADE_URL=https://shorted.com.au/pricing

# Must match the edge worker's bindings of the same names
RATE_LIMIT_SSR_BYPASS_USER_AGENT=shorted-web-ssr
RATE_LIMIT_SSR_BYPASS_HEADER_NAME=x-shorted-ssr-bypass
RATE_LIMIT_SSR_BYPASS_SECRET=...
```

**Rollback is one line:** `rate_limit_enabled = false` in
`terraform/environments/prod/main.tf`.

**Do not verify a secret with `vercel env pull`.** With no `.vercel/project.json`
at the repo root it silently returns a bogus value — it once reported an 11-char
secret against the real 43-char one and looked like a live mismatch. Verify by
*runtime behaviour*: send the marker plus the secret and check that the monthly
headers are absent (verified).
