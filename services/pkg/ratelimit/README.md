# `pkg/ratelimit` — the app-layer limiter

Two limits live here, with independent failure domains:

| Concern | Where | Depends on |
|---|---|---|
| Per-tier **per-minute** | `minute.go` — in memory, per Cloud Run instance | nothing |
| **Monthly** quota | `monthly.go` + `store.go` — Postgres `api_usage_monthly`, batched | the API's existing pgx pool |

The tier-blind abuse ceiling is *not* here — it runs at the Cloudflare edge
worker (`services/edge-worker/`). Design rationale, the August 2026 incident and
the consistency guarantees are documented in the package comments on
`AppLimiter` and `minuteLimiter`, and in the root `CLAUDE.md`.

Three invariants constrain everything in this package, instrumentation included:

1. **No I/O on the request path.** `Check` touches memory only.
2. **Fail open, always.** A sick quota database never 429s or 500s a user.
3. **Bounded key spaces.** Maps are capped, metric attributes come from closed
   sets. An unbounded key space is what caused the incident.

---

## Observability

Instrument names follow the `shorted.<area>.<name>` scheme used by the rest of
`pkg/otel/metrics.go`; instruments are declared there and emitted through
`metrics.go` in this package. Histogram buckets are pinned by Views in
`pkg/otel/otel.go` so bucket count — and therefore series count — is fixed.

### Metrics

| Metric | Type | Attributes | What it tells you |
|---|---|---|---|
| `shorted.rate_limit.checks_total` | counter | `tier`, `access`, `decision`, `kind` | Every decision, allowed or blocked. The denominator `blocked` never had. |
| `shorted.rate_limit.blocked` | counter | `tier`, `kind` | Requests actually rejected (pre-existing). Trailing indicator. |
| `shorted.rate_limit.quota_consumed_ratio` | histogram (`%`) | `tier`, `access` | Percent of monthly quota consumed at decision time. **Leading** indicator — shows callers approaching a limit before they hit it. |
| `shorted.rate_limit.breaker_transitions_total` | counter | `state` = `open`/`half_open`/`closed` | Quota-store circuit breaker state changes. |
| `shorted.rate_limit.flush_total` | counter | `result` = `success`/`failure`/`skipped_breaker_open` | Flush attempts. `skipped_breaker_open` is "not even trying", distinct from "trying and failing". |
| `shorted.rate_limit.flush_rows` | histogram | — | Identifiers per successful flush (batch width; one statement covers all of them). Failed flushes are not recorded. |
| `shorted.rate_limit.retained_deltas` | gauge | `buffer` = `pending`/`orphan` | Unflushed quota increments held in memory. Sampled once per `MonthlyFlushInterval`. |
| `shorted.rate_limit.deltas_dropped_total` | counter | `reason` = `orphan_buffer_full`/`monthly_identifier_cap` | Increments **permanently lost** to a retention cap — i.e. quota silently under-counted. Counts increments, not events. |
| `shorted.rate_limit.store_duration` | histogram (`s`) | `operation` = `apply_deltas`/`totals`, `result` = `ok`/`error` | `api_usage_monthly` statement latency, including failed statements. |
| `shorted.rate_limit.store_errors_total` | counter | `operation`, `class` | Statement errors by bounded class: `timeout`, `canceled`, `connection`, `pool_exhausted`, `decode`, `schema`, `query`. |
| `shorted.rate_limit.minute_identifiers` | gauge | — | Size of the per-minute map, against `MinuteMaxIdentifiers` (default 100k). |
| `shorted.rate_limit.monthly_identifiers` | gauge | — | Identifiers tracked for monthly accounting, against `MonthlyMaxIdentifiers` (default 50k). |
| `shorted.rate_limit.minute_evictions_total` | counter | `reason` = `expired`/`least_recently_seen` | Map pressure. `expired` is routine; `least_recently_seen` means the cap is binding. |
| `shorted.rate_limit.minute_cap_reached_total` | counter | — | Requests that went **unmetered** because the per-minute map was full. |

**Attribute values are a closed set.** `tier` is normalised against a known list
(`anonymous`, `free`, `paid`, `premium`, `pro`, `enterprise`) — anything else
collapses to `other`, empty to `unknown` — because the tier arrives from a
caller's claims and is not closed by construction. `access` is `api` or
`browser`, matching the two columns of the documented tier table.

**No identifier, IP or user id is ever a metric attribute.** That is the whole
reason the quota metric is a bucketed distribution rather than a per-caller
gauge. `TestNoMetricAttributeEverCarriesAnIdentifier` enforces it.

### Logs

| Event | Level | Where |
|---|---|---|
| Rate limit exceeded (tier, access, kind, minute + monthly counts) | info | `interceptor.go` |
| Browser-tier downgraded to API-tier (invalid origin) | debug | `interceptor.go` |
| Per-minute map at capacity — new callers unmetered | warn, throttled to 1/min | `minute.go` |
| Quota flush/refresh failed, deltas retained | warn | `monthly.go` |
| `RATE LIMIT QUOTA DB DEGRADED` — breaker opened, quotas not enforced | error | `monthly.go` |
| `RATE LIMIT QUOTA DB RECOVERED` — breaker closed | info | `monthly.go` |
| Orphan buffer full — a month is now under-counted for a caller | warn | `monthly.go` |

**Logging rule: no raw identifier above debug level.** An identifier is an
end-user IP or a user id. Anything at info/warn/error passes through
`redactIdentifier`, which keeps the scheme prefix (so `ip:` vs `user:` is still
readable) and replaces the value with a stable 8-hex digest — stable so one
caller correlates across lines and instances, hashed so the log is not a store
of personal data. `log.Debugf` may carry the raw value; debug is not shipped.

### What to alert on

Ordered by "wake someone up" first.

1. **Breaker open — quotas are not being enforced.**
   `increase(shorted.rate_limit.breaker_transitions_total{state="open"}[15m]) > 0`
   **Page.** This is the incident shape: the limiter fails open by design, so
   nothing else in the system will tell you monthly quotas stopped applying.
   Pair with the `RATE LIMIT QUOTA DB DEGRADED` log line. Resolve on a matching
   `state="closed"`; a breaker oscillating between `half_open` and `open` is a
   database that is degraded rather than down.

2. **Deltas dropped — quota is being silently under-counted.**
   `increase(shorted.rate_limit.deltas_dropped_total[1h]) > 0` — **page**. This
   is unrecoverable loss, and the only symptom otherwise is a billing argument
   weeks later. `reason=monthly_identifier_cap` means raise
   `MonthlyMaxIdentifiers`; `reason=orphan_buffer_full` means a month rollover
   landed during a long store outage.

3. **Flush failure rate.**
   `rate(flush_total{result!="success"}[15m]) / rate(flush_total[15m]) > 0.5`
   sustained 15m — **page** (it precedes #1). Any non-zero failure rate for >1h
   is a **ticket**. Break down by `store_errors_total{class}`:
   `pool_exhausted` means the shared pgx pool is the problem, not the table;
   `schema` means `api_usage_monthly` is missing — remember prod does **not**
   run `migrate up`.

4. **Retained backlog growing.**
   `shorted.rate_limit.retained_deltas{buffer="pending"}` rising monotonically
   for >30m — **ticket**. Flushes are not landing, and this is how much quota is
   lost if the instance is replaced. Normal steady state is small: bounded by
   `MonthlyFlushThreshold` × active identifiers between flushes.

5. **Per-minute cap reached — limiting silently disabled.**
   `increase(shorted.rate_limit.minute_cap_reached_total[15m]) > 0` — **ticket**.
   Under the current eviction policy a full map evicts rather than going
   unmetered, so **any** value here means the policy or the cap changed. Watch
   `minute_identifiers` against `MinuteMaxIdentifiers` as the early warning, and
   `minute_evictions_total{reason="least_recently_seen"}` as the leading one
   (expired evictions are routine; LRU evictions mean the cap is binding).

6. **Store latency.**
   p99 `store_duration > 2s` — **ticket**. Off the request path, so it cannot
   hurt a user directly, but the statement timeout is 5s and a timeout is three
   failures away from #1.

7. **Blocked-rate shape** (dashboard, not a page).
   `checks_total{decision="blocked"} / checks_total` by `tier` and `kind`. A
   spike in `tier=anonymous, kind=per_minute` is ordinary scraping. A spike in
   `tier=paid` is a **product** problem — a paying customer hitting a ceiling —
   and should be routed to whoever owns pricing, not to on-call.

8. **Quota pressure** (dashboard / weekly).
   The proportion of `quota_consumed_ratio` observations landing in the ≥90%
   and ≥99% buckets, by `tier`. This is the upsell and support-load signal, and
   the reason the histogram exists at all: it answers "who is about to be
   blocked" before anyone is.

### Cost of instrumentation

Request-path instrumentation is exactly two in-memory OTel records
(`checks_total` + `quota_consumed_ratio`) against **precomputed** attribute
sets. Measured on an M2 Max: `Check` 1.3µs → 2.8µs with instrumentation
(`BenchmarkCheckWithInstrumentation`); building the attribute sets per call
instead costs ~5µs, which is why `checkAttrCache` exists. Everything else —
gauges, flush counters, store timings, breaker transitions — is emitted from
the flusher/refresher goroutines or from `store.go`, all already off the
request path. `TestInstrumentationAddsNoRequestPathIO` drives 2,500 `Check`
calls against a store that fails the test if it is touched at all.
