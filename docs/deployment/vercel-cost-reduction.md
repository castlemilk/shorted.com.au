# Shorted Vercel cost reduction

The September 2026 Shorted invoice attributed $104.60 to this project. Function duration ($51.25), origin transfer ($25.00) and ISR writes ($18.20) were the largest lines. This change reduces repeated work in those paths; realized dollar savings require a comparable billing window after rollout.

| Change | Previous behavior | New behavior |
| --- | --- | --- |
| Scheduled warming | 817 scheduled invocations/day, including anonymous session checks | 73/day: hourly about/homepage/static repair plus the daily stock-page warmer |
| Static ISR repair | Invalidated 15 pages every 15 minutes (1,440 forced regenerations/day) | Checks hourly; invalidates only pages marked as missing live data |
| Historical reports and market dates | Rendered on every request | Generate on first request and cache successful data; ingest/correction/publication events invalidate them |
| Sector widget | Six quote requests per refresh | One batched request for 24 symbols, shared by matching widgets |
| Dashboard polling | Continued in hidden tabs | Thirty-minute daily-candle cadence while visible; stale quotes refresh on return |
| `/top` movers | Duplicate histories and up to 50 records per card | Five summary records per card; the table retains its sparklines |
| Statistics cache hits | Started another backend refresh per visitor | Return the valid cached snapshot; the existing TTL controls refresh |
| Functions | Legacy duration billing configuration | Deployment-local Fluid Compute, preserving Sydney, 15s limits for ordinary routes and generated social images, and explicit warmer durations |

The 100-stock/90-point unit fixture shrank from 788,830 to 688,743 JSON bytes (12.69%). Its mover section shrank from 101,627 to 1,540 bytes. These are deterministic test results, not measured production responses or billed transfer savings.

## Freshness and failure behavior

Historical pages use strict cached reads. Backend outages throw rather than turning into cached empty results or false 404s. A successful query with no matching date/report still returns 404. Published report narratives remain usable during the ASIC reporting lag; archive and enrichment failures abort generation so a previous successful ISR page remains available. Available market dates also use an hourly tagged data cache, allowing the index to regenerate when an edge read falls back to Connect. Its previous untagged `no-store` fallback produced a static-generation bailout.

The existing `report-<slug>` publication event also invalidates `reports-index` and the canonical report URL. `shorts-data` or `flush=shorts` invalidates dated market/report route patterns, including previously cached 404s. `market-date:YYYY-MM-DD` corrects one date at both cache layers and clears the market index. Weekly navigation retains its one-hour cache, which can shorten that route's effective ISR interval; the other historical routes have a 24-hour ceiling. Price drops retains hourly ISR with an explicit 60-second cold-render allowance: its backend overview query and retry can exceed the ordinary 15-second limit. This avoids repeated failed regenerations.

Static data pages emit a hidden `data-isr-shell="empty"` marker only for a failed/cold fetch. Legitimate withheld or dated price-drop results do not receive it. A repair reads the existing page, queues invalidation only for that marker and returns HTTP 202 while a repair is pending. Healthy pages are checked without invalidation. HTTP failures return 503; no failed fetch is reported as ready.

Next.js commits `revalidatePath` after a route handler returns. Release workflows therefore make two separate requests: `GET /api/static-pages/warm-cache?mode=deploy` invalidates build shells, then `GET ...?mode=repair` fetches them with live data. The static warmer allows 60 seconds to read the cold price-drop page and 30 seconds for other pages, with five concurrent reads and a 150-second handler ceiling. Its release callers allow 145 seconds. Both release workflows prime after promotion. Periodic smoke uses repair mode and separate public reads, preserving the Cloudflare testing user agent **and** secret header. Warming uses the internal deployment origin to avoid Cloudflare challenges, and an existing automation protection bypass when provided. All warm routes accept the warm header, legacy query secret, or an authenticated Vercel cron bearer token.

The batched quote proxy has a narrow 60-second function ceiling and a 55-second upstream deadline. Credential-free backend checks returned valid four- and 24-symbol results in 33–35 seconds; the former 15-second proxy ceiling aborted them. Keeping one browser/proxy call avoids repeating those requests through six functions. The deadline is a compatibility bound, not evidence that the underlying database query is fast.

## Shared quote caching and request reduction

The batch proxy validates and canonicalizes 1–50 symbols, then reads the cache generation and their public prices with one GET and one MGET. Every visitor still passes the existing application rate limit before reading the cache. Fresh quotes are shared per symbol for 30 minutes, so overlapping portfolios reuse prices. Successful missing-symbol coverage lasts five minutes. Invalid payloads, transport failures and cancellations never create negative coverage. Valid last-good prices remain available for up to 24 hours during an outage, with `X-Quote-Cache: STALE`; the candle's original date and cache age are preserved. Responses use `Cache-Control: no-store` and expose `X-Quote-Cache: HIT|MISS|STALE` for verification.

Within a Fluid instance, overlapping misses subscribe to one refresh per symbol. Across instances, an atomic 60-second lease coalesces identical canonical missing-symbol batches. Lease waiters use bounded batched polling rather than one read per symbol. Different overlapping batches on different instances can still overlap upstream work. Redis failures degrade to upstream reads; they do not invent cache hits. Writes use SETEX pipelines, and leases release only when their owner token matches.

The daily price-sync job calls the existing revalidation endpoint when it commits prices, including a partially completed run. Authenticated `POST /api/revalidate?flush=quotes` updates a generation with one SET, without scanning the keyspace. A late refresh from the previous generation cannot produce a valid hit. The 30-minute freshness ceiling remains the fallback if a notification fails. Deploy the job's existing `REVALIDATION_SECRET` binding and revalidation URL along with the web change; no new credential is generated.

The backend batch query seeks the latest two observations for each requested symbol through the existing `(stock_code, date DESC)` index. It avoids walking each symbol's whole price history. Missing symbols and single-observation symbols preserve their response behavior; a row decoding/iteration failure returns an error instead of a misleading partial success.

The first request to the isolated indexed-query backend candidate took 11.7 seconds; its Cloud Run startup trace showed a 10-second wait before the first health probe. The market-data startup probe now has zero initial delay, a one-second period and timeout, and 40 allowed failures. This removes the configured wait while retaining a 40-second startup allowance and the existing `/health` endpoint and database startup checks, without increasing minimum instances or idle-instance cost. [Cloud Run health-check documentation](https://docs.cloud.google.com/run/docs/configuring/healthchecks) defines the initial delay and probe timing. Cold-start latency with this configuration still requires a live candidate check before rollout; the 11.7-second result predates the probe change.

Quote hooks and widgets share canonical React Query keys and use the same 30-minute freshness interval. Search enrichment's 1.5-second budget cancels the actual fetch and retry delay. Disposing one observer leaves a shared request alive for its other observers; disposing the last observer aborts it. Canceled and permanent HTTP failures do not retry, while transient rate-limit responses retain the existing bounded Retry-After policy.

The 100 `/top` table links and 15 mover links disable automatic viewport prefetching. A cancelable 150ms pointer/focus intent starts one prefetch per mounted link. Normal and modified clicks retain standard Next.js link behavior and table sparklines are preserved.

## Validation and rollout

Run web Jest, TypeScript, lint, a production build, bundle budgets and the existing release pipeline contracts. The build table must show `/market/[date]` and the three report detail routes as static/on-demand (`●`). Verify healthy repair requests do not invalidate cache entries, invalidation/priming use separate requests, publication clears a cached 404, and corrections reach both data cache layers. Validate visible/resumed widget behavior and mover/table rendering in a browser.

Use the true-preview procedure and bounded benchmark in [fluid-compute-validation.md](./fluid-compute-validation.md). A preview uses preview environment variables; promote only a separately smoked production-environment candidate through the existing release pipeline. Keep the prior verified production deployment available for rollback. No paid Observability add-on or dashboard CPU/region change is required.

After rollout, compare traffic-normalized Function Duration/Active CPU, provisioned memory, origin transfer and ISR writes against September's baseline. HTTP timing and configured cron/request counts establish behavior changes; they do not establish realized dollar savings.
