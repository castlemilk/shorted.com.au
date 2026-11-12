# Event-driven caching

The site's data (ASIC short positions) changes ~once/day, so we cache **hard**
and refresh **on the data-change event** rather than on a timer.

## Layers (all "cache hard, bust on change")

| Layer | Holds | TTL ceiling | Busted on change by |
|---|---|---|---|
| **Next.js ISR / Full Route Cache** | rendered SSR pages (`/`, `/top`, `/news`, `/shorts/[code]`) | 24h (`export const revalidate = 86400`) | `revalidatePath` via `/api/revalidate` |
| **Next.js Data Cache** | per-stock core RPC data (`GetStock`, `GetStockDetails`, `GetStockData`, enriched metadata) | 24h (`STOCK_PAGE_CACHE_SECONDS`) | per stock: `revalidateTag("stock:<CODE>")` from the sync's change set; everything: `revalidateTag("shorts-data")` via `/api/revalidate?tag=shorts-data` |
| **Redis (Upstash/ioredis)** | API responses (`getOrSetCached`) | 24h (`HOMEPAGE_TTL`…) | `deleteCachedByPrefix` via `/api/revalidate?flush=shorts` |
| **Cloudflare edge** | API responses and public `/shorts/[code]` HTML | API: 2–5m; stock HTML: 24h | API self-expires; stock HTML follows cache rule + daily revalidation/purge path |

The 24h ceilings are a **safety net** — if a revalidation event is ever missed,
nothing stays stale longer than a day. The real refresh is event-driven.

`/shorts/[stockCode]` pre-generates the top 30 shorted stocks at build time via
`generateStaticParams()`. The long tail keeps `dynamicParams = true`, so the
first uncached request can still render on demand and then be cached.

## The data-change event

`short-data-sync` writes only rows that are new or that ASIC changed, so
`records > 0` **is** the "data actually changed" signal (a no-new-files run does
nothing). After a successful write it:
1. `SELECT refresh_all_materialized_views()` — so the MVs reflect the new data.
2. `POST $REVALIDATION_URL?tag=scan-results&path=/,/top,/news,/screener,/industry,/statistics,/scans&flush=shorts`
   (secret in `X-Revalidate-Secret`) with the run's change set as the body:
   `{"shorts": {"codes": [...], "dates": [...]}}` — every code on a row it
   wrote and every report date those rows are for.

`/api/revalidate` then expires, and only expires (`app/api/revalidate/shorts-change.ts`):
- `stock:<CODE>` for each written stock: its data reads and, through the tags
  each page collects from its reads, every tab of `/shorts/<CODE>`, its OG card,
  its chart share page and any comparison that includes it;
- `shorts-latest`: reads built from the newest snapshot across all stocks (top
  shorts, the treemap, the screener, statistics, themes, battlegrounds);
- `market-index`, and `market-date:<date>` + `/market/<date>` for each written
  date (a date that was a cached 404 becomes real);
- the weekly, monthly and yearly report covering each written date, by
  `report-<slug>` tag and by path;
- the newest-snapshot paths in the query, and the shorts Redis family.

A routine day writes one date of ~800 codes, so the other ~3,600 stocks' cached
pages are left alone. The change set goes in requests of at most 250 stocks
(only the first carries the paths and the Redis flush); if any of them is
refused or unreachable, the job sends the broad request below instead, so a
failed narrow bust never leaves a stock on old data for its day-long window. A run that cannot name what it wrote (an initial load), or
names more than 2,000 codes or 45 dates, sends the **broad** request instead:
`tag=shorts-data,scan-results` plus the same paths and `/shorts/[stockCode]`,
which expires every stock page, every market date and every report. So does any
caller that sends `tag=shorts-data` or `flush=shorts` without a change set (the
deploy sweep, an operator). Every shorts read keeps the broad `shorts-data` tag
beside its narrow one; `web/src/app/actions/__tests__/shorts-tag-scopes.test.ts`
fails on a read tagged only `shorts-data`, which a narrow sync would never
refresh.

## Path revalidation on Vercel

A plain `revalidatePath(p)`, with no type, expires every page under `p` on Vercel, not only
the page at `p`. Next's docs and the derived tags in `next/dist/server/lib/implicit-tags.js`
say it should reach only `p` (`_N_T_/housing` is not among a `/housing/vic` page's tags), but
production does otherwise. Measured 2026-11-09 from `vercel logs` (`cacheReason`) and the
collector's own log line:

- **`path=/housing`, no tag.** At 05:30 the `crawl-finalize` ping (`crawl cache bust ok`, the
  only ping in that window) sent `path=/price-drops,/housing&flush=housing`. Of the 13
  `/housing/*` pages cached before it and visited after it, 12 came back
  `REVALIDATED delete_tag` and 1 cold. No stock, economy or ownership page did.
- **`path=/`.** The shorts sync's narrow bust at 00:33:57 sent `/` among its paths. Economy,
  ownership and strategies pages came back `delete_tag` within the next 25 minutes. The
  economy state pages read only `getEconomicSeries` (`economy-state-companies`, otherwise
  time-based at an hour), and no ping named those. One ownership page was cached at 00:33:28,
  after the 00:30 crawl ping, so only the sync could have expired it.

So `/` expired the whole site on every daily sync and on every news publish
(`scripts/take-writer` sends `path=/news,/news/<slug>,/`; there were 9 on 2026-11-09 between
03:15 and 05:05 UTC). `/api/revalidate` now sends `/` as `revalidatePath("/", "page")`, which
reaches the home page alone (its derived tag is `_N_T_/page`). The home page's data carry
`shorts-latest` and report tags, which the sync already expires.

Rules for any caller:
- To refresh one page, use its page-typed route or a tag its reads carry. Never send an untyped
  parent path to refresh the parent: `/housing` is every housing page, and `/news` is every
  article. A dynamic page needs its route pattern, not a concrete URL with `"page"`: for
  example `/housing/[state]/council` targets the state council indexes without their profiles.
- A pattern with brackets is page- or layout-typed already (`/shorts/[stockCode]` as a layout,
  others as a page) and behaves as documented.
- To tell a tag expiry from a path expiry, compare `cacheReason` brackets against
  `/api/revalidate` timestamps. Pings to `shorted.com.au` come from Cloud Run and VKE; pings
  to the Vercel origin host come from the rigs and `take-writer`.

The daily page warmer invalidates only `/` as a page and then fetches the homepage in a second
request. The deployment shell warmer also page-types each route, including the shared council
index pattern; it must not expire the housing, market, economy or ownership subtrees when it
repairs a parent shell. Invalidation and the read that primes it must remain separate requests:
Next commits `revalidatePath` after the handler returns.

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
