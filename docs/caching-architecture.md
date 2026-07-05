# Event-driven caching

The site's data (ASIC short positions) changes ~once/day, so we cache **hard**
and refresh **on the data-change event** rather than on a timer.

## Layers (all "cache hard, bust on change")

| Layer | Holds | TTL ceiling | Busted on change by |
|---|---|---|---|
| **Next.js ISR / Full Route Cache** | rendered SSR pages (`/`, `/top`, `/news`, `/shorts/[code]`) | 24h (`export const revalidate = 86400`) | `revalidatePath` via `/api/revalidate` |
| **Next.js Data Cache** | per-stock core RPC data (`GetStock`, `GetStockDetails`, `GetStockData`, enriched metadata) | 24h (`STOCK_PAGE_CACHE_SECONDS`) | `revalidateTag("shorts-data")` via `/api/revalidate?tag=shorts-data` |
| **Redis (Upstash/ioredis)** | API responses (`getOrSetCached`) | 24h (`HOMEPAGE_TTL`…) | `deleteCachedByPrefix` via `/api/revalidate?flush=shorts` |
| **Cloudflare edge** | API responses and public `/shorts/[code]` HTML | API: 2–5m; stock HTML: 24h | API self-expires; stock HTML follows cache rule + daily revalidation/purge path |

The 24h ceilings are a **safety net** — if a revalidation event is ever missed,
nothing stays stale longer than a day. The real refresh is event-driven.

`/shorts/[stockCode]` pre-generates the top 30 shorted stocks at build time via
`generateStaticParams()`. The long tail keeps `dynamicParams = true`, so the
first uncached request can still render on demand and then be cached.

## The data-change event

`short-data-sync` only processes **new** ASIC CSVs, so `records > 0` **is** the
"data actually changed" signal (a no-new-files run does nothing). After a
successful write it:
1. `SELECT refresh_all_materialized_views()` — so the MVs reflect the new data.
2. `POST $REVALIDATION_URL?secret=…&tag=shorts-data&path=/,/top,/news,/screener,/industry,/shorts/[stockCode]&flush=shorts`.

`/api/revalidate` (enhanced) then invalidates the shared stock data tag,
`revalidatePath`s each page (patterns with `[..]` bust the whole dynamic route),
and prefix-flushes the shorts-data Redis keys. Backward-compatible with the
existing single-`tag` callers (weekly-report-generator still works).

## GetTopShorts payload

The top-shorts list sparklines no longer ship full daily resolution — the
backend **decimates** each series to ≤60 evenly-spaced points
(`getTopshorts.go`, `decimatePoints`). Min/Max/Latest are still computed from the
full series, so markers and the current value stay exact. A 50-stock 6-month
response drops from ~370KB to a fraction.

## Rollout

1. **Deploy** the shorts service (decimation), web (revalidate route + pages +
   Redis), short-data-sync.
2. **Terraform apply** — short-data-sync now gets `REVALIDATION_URL`
   (default `https://shorted.com.au/api/revalidate`) + `REVALIDATION_SECRET`
   (Secret Manager, already exists for weekly-report-generator). No prod/main.tf
   change needed (module default).
3. **Verify**: trigger a sync (or `POST /api/revalidate?secret=…&path=/&flush=shorts`)
   and confirm the homepage re-renders with fresh data; check the sync logs for
   "Triggered cache revalidation (status 200)".

## Follow-ups (not in this change)
- **Edge purge**: wire `/api/cache/purge` into the same data-change event if the
  Cloudflare stock-page HTML rule needs immediate global eviction rather than
  relying on the 24h ceiling plus route/data revalidation.
- **Stock pages on price change**: have `market-data-sync` revalidate
  `/shorts/[stockCode]` after a price sync (currently only the daily short-data
  event busts them).
- **`summaryOnly`**: switch the compact/card top-shorts widgets (no sparkline) to
  `summaryOnly: true` to drop their payload to current-% only.
