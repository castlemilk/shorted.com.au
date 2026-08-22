# Shorted Edge Worker

Cloudflare Worker fronting **both** `api.shorted.com.au` (multi-tier caching
proxy) and `shorted.com.au` (transparent proxy to Vercel).

| File | Purpose |
|---|---|
| `worker.js` | Main worker — routing, caching, edge reads, **per-minute rate limiting** |
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

The app layer keeps only **monthly** quota accounting, batched — see
`services/pkg/ratelimit/monthly.go`.

### Two buckets

The worker cannot know a caller's paid tier without a database lookup, and
doing one at the edge would reintroduce exactly the coupling we removed. So the
scheme is deliberately tier-blind:

| Binding | Key | Limit | Applies to |
|---|---|---|---|
| `API_KEY_RATE_LIMITER` | `k:<sha256(token)[0:32]>` | **120/min** | Any request carrying `Authorization` (bearer or bare) or `X-API-Key` |
| `ANON_RATE_LIMITER` | `a:<client IP>` | **30/min** | Requests with **no** credential |

- **120/min is an abuse ceiling, not a tier.** It sits at or above every
  documented per-minute tier (anonymous 30, free 60/120, paid 120). A paid
  subscriber's *unlimited* per-minute entitlement stays effectively unlimited:
  120 req/min is 2 req/s sustained, far beyond any interactive session. The
  ceiling exists so a leaked or shared token cannot hammer the origin.
- **30/min for anonymous** matches the documented anonymous API tier exactly.
- Tokens are **hashed** before they become part of a key — raw credentials never
  enter rate-limit state.

Counters are **per-colo and eventually consistent** (documented Cloudflare
behaviour), so the effective global ceiling is the configured limit times the
number of colos a client reaches. That is fine for an abuse ceiling, and is a
second reason the precise monthly quota stays app-side.

### Bypasses (must mirror the zone skip rules)

Two traffic classes are already exempted from the **zone** rate limiter in
`terraform/modules/cloudflare-edge/main.tf`, and the worker exempts the same
two — otherwise the worker would re-impose the limit the zone rule deliberately
skips:

| Class | UA marker | Secret header |
|---|---|---|
| Trusted E2E / load tests | `Shorted-E2E` | `x-shorted-testing-bypass` |
| First-party Vercel SSR | `shorted-web-ssr` | `x-shorted-ssr-bypass` |

**Both** the UA marker and the exact secret are required — never the UA alone,
which anyone can spoof. An empty secret disables that class entirely. This is
the same rule the Terraform expressions enforce.

### Failure behaviour

The limiter fails **open** in every ambiguous case: missing binding, throwing
binding, malformed outcome, exempt path — and enforcement is **opt-in**:
anything other than `EDGE_RATE_LIMIT_ENABLED=true` (including the flag being
absent) disables it. Rate limiting must never be the reason the API is down.

### Enablement precondition (read before flipping the flag)

Anonymous browser API traffic reaches this worker via the **Vercel rewrite
proxy** (`next.config.mjs` routes `/shorts.v1alpha1.*` to `api.shorted.com.au`
deliberately, for worker-cache hits). The worker therefore sees a shared
Vercel egress IP as `cf-connecting-ip` for every anonymous visitor — enabling
the 30/min anon bucket in that state collapses all of them onto a handful of
keys and 429s real users. Before enabling: give rewrite-proxied requests a
first-party identity (e.g. attach the SSR bypass header via Next middleware)
or re-key the anon bucket. Signed-in browser traffic is safe (its bearer
token lands in the per-token bucket).

### Configuration

Terraform variables (`terraform/modules/cloudflare-edge/variables.tf`):

| Variable | Default | Meaning |
|---|---|---|
| `edge_rate_limit_enabled` | `false` | Opt-in switch (sets `EDGE_RATE_LIMIT_ENABLED`); see enablement precondition above |
| `edge_rate_limit_key_requests_per_minute` | `120` | Per-token ceiling |
| `edge_rate_limit_anon_requests_per_minute` | `30` | Per-IP ceiling |
| `edge_rate_limit_key_namespace_id` | `"2001"` | CF rate-limit namespace for the token bucket |
| `edge_rate_limit_anon_namespace_id` | `"2002"` | CF rate-limit namespace for the anon bucket |

`namespace_id` is an account-scoped identifier **you choose** — there is no
provisioning step. Two bindings sharing a `namespace_id` share counters *even
across different Workers on the account*, so keep these unique. `period` must
be exactly `10` or `60`; we use `60`.

Binding syntax reference:
<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>

### Operator actions required for rollout

1. **Apply Terraform** (dev first, then prod) so the two `ratelimit` bindings
   and the bypass `secret_text` bindings reach the worker:

   ```bash
   cd terraform/environments/prod
   terraform plan    # expect: 2 new ratelimit bindings + bypass secrets on cloudflare_workers_script.edge_cache
   terraform apply
   ```

   The bypass secrets come from the existing CI variables
   `TF_VAR_rate_limit_testing_bypass_secret` and
   `TF_VAR_rate_limit_ssr_bypass_secret` (GitHub secret
   `CLOUDFLARE_SSR_BYPASS_SECRET`). No new secret needs minting — but if either
   is unset in an environment, that bypass class is disabled there and
   first-party SSR / E2E traffic will be subject to the edge buckets.

2. **Point app-layer quota accounting at a dedicated Upstash database** — see
   `RATE_LIMIT_UPSTASH_REDIS_REST_URL` / `_TOKEN` in the root `CLAUDE.md`. Rate
   limiting and the page cache must never share a quota again.

3. **Verify at the edge** after apply:

   ```bash
   for i in $(seq 1 40); do
     curl -s -o /dev/null -w '%{http_code}\n' https://api.shorted.com.au/edge/v1/top-shorts
   done | sort | uniq -c   # expect 429s to appear past the anonymous bucket
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
