# Shorted Vercel cost reduction

The September 2026 Shorted invoice attributed $104.60 to this project. Function duration ($51.25), origin transfer ($25.00) and ISR writes ($18.20) were the largest lines. This change reduces repeated work in those paths; realized dollar savings require a comparable billing window after rollout.

| Change | Previous behavior | New behavior |
| --- | --- | --- |
| Scheduled warming | 817 scheduled invocations/day, including anonymous session checks | 73/day: hourly about/homepage/static repair plus the daily stock-page warmer |
| Static ISR repair | Invalidated 15 pages every 15 minutes (1,440 forced regenerations/day) | Checks hourly; invalidates only pages marked as missing live data |
| Historical reports and market dates | Rendered on every request | Generate on first request and cache successful data; ingest/correction/publication events invalidate them |
| Sector widget | Six quote requests per refresh | One batched request for 24 symbols, shared by matching widgets |
| Dashboard polling | Continued in hidden tabs | Five-minute cadence while visible; stale quotes refresh on return |
| `/top` movers | Duplicate histories and up to 50 records per card | Five summary records per card; the table retains its sparklines |
| Statistics cache hits | Started another backend refresh per visitor | Return the valid cached snapshot; the existing TTL controls refresh |
| Functions | Legacy duration billing configuration | Deployment-local Fluid Compute, preserving Sydney, 15s limits for ordinary routes and generated social images, and explicit warmer durations |

The 100-stock/90-point unit fixture shrank from 788,830 to 688,743 JSON bytes (12.69%). Its mover section shrank from 101,627 to 1,540 bytes. These are deterministic test results, not measured production responses or billed transfer savings.

## Freshness and failure behavior

Historical pages use strict cached reads. Backend outages throw rather than turning into cached empty results or false 404s. A successful query with no matching date/report still returns 404. Published report narratives remain usable during the ASIC reporting lag; archive and enrichment failures abort generation so a previous successful ISR page remains available.

The existing `report-<slug>` publication event also invalidates `reports-index` and the canonical report URL. `shorts-data` or `flush=shorts` invalidates dated market/report route patterns, including previously cached 404s. `market-date:YYYY-MM-DD` corrects one date at both cache layers. Weekly navigation retains its one-hour cache, which can shorten that route's effective ISR interval; the other historical routes have a 24-hour ceiling.

Static data pages emit a hidden `data-isr-shell="empty"` marker only for a failed/cold fetch. Legitimate withheld or dated price-drop results do not receive it. A repair reads the existing page, queues invalidation only for that marker and returns HTTP 202 while a repair is pending. Healthy pages are checked without invalidation. HTTP failures return 503; no failed fetch is reported as ready.

Next.js commits `revalidatePath` after a route handler returns. Release workflows therefore make two separate requests: `GET /api/static-pages/warm-cache?mode=deploy` invalidates build shells, then `GET ...?mode=repair` fetches them with live data. Both release workflows prime after promotion. Periodic smoke uses repair mode and separate public reads, preserving the Cloudflare testing user agent **and** secret header. Warming uses the internal deployment origin to avoid Cloudflare challenges, and an existing automation protection bypass when provided. All warm routes accept the warm header, legacy query secret, or an authenticated Vercel cron bearer token.

## Validation and rollout

Run web Jest, TypeScript, lint, a production build, bundle budgets and the existing release pipeline contracts. The build table must show `/market/[date]` and the three report detail routes as static/on-demand (`●`). Verify healthy repair requests do not invalidate cache entries, invalidation/priming use separate requests, publication clears a cached 404, and corrections reach both data cache layers. Validate visible/resumed widget behavior and mover/table rendering in a browser.

Use the true-preview procedure and bounded benchmark in [fluid-compute-validation.md](./fluid-compute-validation.md). A preview uses preview environment variables; promote only a separately smoked production-environment candidate through the existing release pipeline. Keep the prior verified production deployment available for rollback. No paid Observability add-on or dashboard CPU/region change is required.

After rollout, compare traffic-normalized Function Duration/Active CPU, provisioned memory, origin transfer and ISR writes against September's baseline. HTTP timing and configured cron/request counts establish behavior changes; they do not establish realized dollar savings.
