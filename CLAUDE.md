# CLAUDE.md - Project Context for AI Assistants

Context for AI coding assistants (Claude, Cursor, etc.) working on the
Shorted.com.au codebase. This file holds what every session needs: how to run
things, where things live, and the rules that have bitten before. Each feature's
full record (every landmine, every measurement) lives in `docs/` and is linked
from its section here. **A new landmine goes in the feature's doc; only a rule
every session needs goes here.**

## Quick Start

`task` is the front door. `task --list` shows the everyday operations, grouped so
the list reads as a risk map (anything under a `prod:` segment writes to
production and requires `CONFIRM=prod`). The Makefiles still exist and still
work; the Taskfile curates the ~40 operations people actually reach for and pins
the things that are dangerous to get wrong:

```bash
task setup            # fresh clone -> deps, hooks, local DB, migrations
task dev:up           # start the stack, then report which ports are live
task verify           # the pre-commit gate
task check            # the pre-push gate (adds lint + integration)
task debug:doctor     # tools, ports, DB reachability in one shot

task db:prod:apply --summary   # long help lives on the tasks that fail silently
```

Three properties it enforces that a bare make target cannot: the database DSN is
never ambient (an exported prod `DATABASE_URL` cannot retarget a local command),
prod writes require an explicit variable rather than a prompt (`task --yes`
cannot bypass them), and every Go invocation sets `GOWORK=off` so it matches CI.
Guarded by `scripts/tests/taskfile-safety.test.mjs`.

```bash
make install          # first time setup
make dev              # database + backend + frontend
make test             # lint + build + unit + integration
make dev-stop
```

## Project Overview

Shorted.com.au tracks short selling positions in the Australian stock market. It
ingests daily ASIC short selling data, enriches it with company metadata, and
provides a dashboard for users to analyze short positions. Around that core sit
the strategies picker, the ownership explorer, housing, economy, the register of
interests, reports, an MCP server, a Discord bot and an X bot.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│                    Next.js 15 (port 3020)                           │
│              TailwindCSS, Radix UI, Visx Charts                     │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ Connect-RPC (HTTP/2)
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Backend Services                             │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  Shorts API      │  Market Data     │  Chat Service                  │
│  Go (port 9091)  │  Go (port 8090)  │  Go + Gemini LLM              │
│  Main API + MCP  │  Stock prices    │  AI chat + streaming           │
├──────────────────┴──────────────────┴───────────────────────────────┤
│  Enrichment Processor  │  News Aggregator  │  Jobs monolith          │
│  Go + GPT-4            │  Go + Gemini Flash│  shorted <job> (sync…)  │
└──────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       PostgreSQL (port 5438)                         │
│              Tables: shorts, company-metadata, stock_prices          │
└─────────────────────────────────────────────────────────────────────┘
                      ▲
                      │ Daily sync (ASIC CSV files, 2 AM AEST)
```

Backend services run on Cloud Run; scheduled jobs are moving to Kubernetes
CronJobs on the omega VKE cluster (see "Scheduled jobs on Kubernetes"); the web
app is on Vercel behind Cloudflare.

## Key Services

| Service          | Port | Directory                        | Description                                    |
| ---------------- | ---- | -------------------------------- | ---------------------------------------------- |
| Frontend         | 3020 | `web/`                           | Next.js app with dashboard, stock pages        |
| Shorts API       | 9091 | `services/shorts/`               | Main API for short position data               |
| MCP server       | 9091 | `services/shorts/internal/mcp/`  | `/mcp` — 32 read-only tools, plus the signed-in user's six alert tools behind `alerts:write`; OAuth 2.1 (same process as the Shorts API) |
| Market Data      | 8090 | `services/market-data/`          | Historical stock prices                        |
| Chat Service     | -    | `services/chat-service/`         | AI chat with Gemini LLM + 8 API tools          |
| News Aggregator  | -    | `services/news-aggregator/`      | RSS news aggregation + Gemini sentiment        |
| Enrichment       | -    | `services/enrichment-processor/` | AI-powered company metadata                    |
| Jobs monolith    | -    | `services/jobs/`                 | `shorted <job>` — scheduled jobs incl. ASIC sync (`services/jobs/README.md`) |
| Report extractor | -    | `services/report-extractor/`     | Python; parses ASX results documents and Appendix 3Y notices |
| Weekly reports   | -    | `services/weekly-report-generator/` | LLM-generated weekly / monthly / yearly reports |
| Edge worker      | -    | `services/edge-worker/`          | Cloudflare worker: API cache + tier-blind rate limiting |

## Database

### Development

```
postgresql://admin:password@localhost:5438/shorts
```

### Production (Supabase)

- Host `aws-0-ap-southeast-2.pooler.supabase.com`. **Transaction pooler port
  6543** for queries; **session pooler 5432** for DDL, `REFRESH MATERIALIZED
  VIEW` and anything long (the transaction pooler kills a long statement
  mid-flight). Limits: max_connections 60, shared_buffers 224 MB, work_mem 2 MB.
- **Prod does not run `migrate up`.** The deploy (`terraform-deploy.yml`)
  replays a hardcoded allowlist of replay-safe migrations before the image swap.
  Anything else is applied BY HAND, before merging the code that reads it:
  `task db:prod:apply FILE=services/migrations/<file> CONFIRM=prod` (session
  pooler, one transaction, `SET LOCAL statement_timeout = 0`; `PGOPTIONS` does
  nothing because Supavisor drops it). Prod `schema_migrations` lies (force-written
  to 75). Record what was applied in `services/migrations/PROD_APPLIED.md`.
- MV refresh: `task db:prod:refresh CONFIRM=prod` (`WHICH=housing|suburbs` for
  those sets).
- **Supabase Data API: closed by `000138_harden_data_api_grants`; keep it
  closed.** PostgREST serves whatever `anon` and `authenticated` can reach in
  `public` to anyone with the non-secret anon key, and nothing here uses it.
  Never `GRANT` anything to `anon`, `authenticated` or `PUBLIC`, make one of
  them an owner, create a policy, or FORCE/DISABLE row level security, in ANY
  `.sql` file: `services/migrations/data_api_grants.test.mjs` fails. A
  `SECURITY DEFINER` function pins `search_path` and revokes `PUBLIC`'s EXECUTE
  in the same file. Closed = zero rows from
  `task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql`.
  000138 stays the LAST file the deploy replays, so each deploy re-closes what
  the others open; a new allowlisted migration goes ABOVE it in
  `terraform-deploy.yml`. Runbook: `docs/operations/supabase-data-api.md`.

### Core tables

| Table | Rows | Description |
|-------|------|-------------|
| `shorts` | ~2.1M | Daily ASIC short position data: `DATE`, `PRODUCT`, `PRODUCT_CODE`, `REPORTED_SHORT_POSITIONS`, `TOTAL_PRODUCT_IN_ISSUE`, `PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS` |
| `stock_prices` | ~3.7M | `stock_code`, `date`, OHLC + `adjusted_close` NUMERIC(12,4) (DECIMAL(10,2) before 000131), `volume` |
| `company-metadata` | ~4.5K | `stock_code` UNIQUE; name, sector, industry, market_cap, logos, website, description; GPT-4 enrichment fields; `key_metrics` JSONB; `search_vector` |
| `index_prices` | - | XJO, XAO, XKO, XJT daily levels, kept out of `stock_prices` on purpose (an index is not a security) |
| `sync_status` | - | Tracks data sync runs (the ASIC recorder and the price sweep share it) |

Key indexes: `shorts_date_product_code_unique` (DATE, PRODUCT_CODE);
`idx_shorts_timeseries_full` ON (PRODUCT_CODE, DATE DESC) INCLUDE (percent,
positions, total) — the covering index for the chart and sparkline reads
(000141, hand-applied; 000142/000143 drop the two older indexes once the chart's
plan uses it); `idx_shorts_percent_nonzero`; `idx_stock_prices_stock_date` and
`stock_prices_stock_code_date_key` UNIQUE (stock_code, date).

**Benchmark indices** are fetched by `shorted market-data index-sync` (CronJob
`shorted-index-sync`, daily, `-years 2`). Each bar is dated by its ASX session
(Sydney date), not its UTC day. A clean-up that would remove more than 15% of a
window's rows is refused. The one-off full re-fetch (`-years 21`) ran on
2026-11-05, so the whole stored history is dated by ASX session. Operator steps:
`services/jobs/README.md` "Benchmark indices".

### Materialized views

| View | Purpose |
|------|---------|
| `mv_top_shorts` | Top shorted stocks with metadata (~6ms vs ~2,300ms raw) |
| `mv_treemap_data` | Treemap by period (3m, 6m, 1y, 2y, 5y, max) and industry |
| `mv_watchlist_defaults` | Default watchlist stocks (CBA, BHP, CSL, WBC, ANZ, RIO, WOW, TLS) |
| `mv_screener_data` | Screener rows incl. days to cover (000027, 000028) |
| `mv_price_features`, `mv_market_regime`, `mv_fundamentals_growth`, `mv_fundamentals_quality` | The strategies picker (see Strategies) |

`SELECT refresh_all_materialized_views();` refreshes the first three (the daily
sync does it after loading). The picker views are refreshed by `shorted picks
-mode refresh` AFTER the price sweep, not by that function. Handlers that read an
MV fall back to the raw query so tests and dev work without it.

## Common Tasks

### Adding a new API endpoint

`shorts.v1alpha1` is split into **per-domain proto files**, each with its own
service: `market.proto` (MarketService), `stock.proto`, `housing.proto`,
`economy.proto`, `news.proto`, `screener.proto`, `search.proto`,
`reports.proto`, `enrichment.proto`, `billing.proto`, `alerts.proto`,
`industry.proto`, `strategies.proto`, `ownership.proto`. `shorts.proto` keeps
only the legacy monolithic `ShortedStocksService` (every rpc, message-less, for
external API consumers). **Web code imports from the domain module**
(`~/gen/shorts/v1alpha1/<domain>_pb`), never from `shorts_pb` (it drags the full
legacy descriptor into the route bundle; `bundle:budget` catches it).

1. Define the rpc + messages in the domain file AND add the same rpc to the
   legacy `ShortedStocksService` in `shorts.proto` (the parity test runs on
   pull requests). Annotate visibility on BOTH copies; unannotated methods
   default to auth-required:
   ```protobuf
   rpc GetNewEndpoint(GetNewEndpointRequest) returns (GetNewEndpointResponse) {
     option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
   }
   ```
2. `cd proto && buf generate` and commit ALL outputs, including the `sdks/java`
   churn. A field on an existing response needs only the proto and `make openapi`.
3. Implement the handler in `services/shorts/internal/services/shorts/`: one
   `ShortsServer` struct implements every service, so a new method satisfies
   both the domain handler and the legacy one. A NEW domain service is mounted
   in `serve.go` with the shared `interceptors` + `withCORS`, gets a rewrite
   rule in `web/next.config.mjs`, and internal-only methods go in
   `internalOnlyMethods` (middleware_connect.go).
4. Add the store method in `services/shorts/internal/store/shorts/`.
5. Frontend: import the generated types from the domain `_pb` module and
   `createClient(<Domain>Service, transport)`.

### Adding a React component

Generic UI in `web/src/@/components/ui/`, feature components in
`web/src/@/components/<feature>/`. `"use client"` only when needed; `cn` from
`@/lib/utils`; props documented with JSDoc.

### Database migrations

```bash
cd services
make migrate-create NAME=add_users_table
make migrate-up / migrate-down / migrate-version
```

### Running tests

```bash
make test                    # everything (lint + build + unit + integration)
make test-frontend / test-backend
make test-integration-local  # requires Docker
cd web && npm run test:e2e   # Playwright
npm run test:e2e:stripe:testmode   # Stripe checkout smoke bench (test mode only)
```

Stripe: the canonical Premium price env is `STRIPE_PREMIUM_PRICE_ID`
(`STRIPE_PRO_PRICE_ID` is a legacy fallback only); API Access checkout is
`STRIPE_API_ACCESS_PRICE_ID`. The smoke bench covers checkout creation and the
redirect to `checkout.stripe.com` only; do not parse checkout response bodies
from Playwright network responses (cross-origin redirect timing makes them
unavailable).

### Populating data

```bash
make populate-data           # downloads ASIC files
make populate-data-quick     # uses existing CSV files
cd services && make history.stock-data.backfill
```

## Key Files

| File                                    | Purpose                                   |
| --------------------------------------- | ----------------------------------------- |
| `Taskfile.yml`, `Makefile`, `services/Makefile`, `web/Makefile` | Orchestration |
| `proto/buf.yaml`                        | Protobuf configuration                     |
| `terraform/environments/prod/`          | Production infrastructure config           |
| `services/migrations/`                  | Database migrations (`PROD_APPLIED.md` records hand applies) |
| `deploy/kubernetes/jobs/`               | VKE CronJobs chart + Paprika application   |
| `.github/workflows/terraform-deploy.yml`| The deploy (runs on Cuttlefish)            |
| `.github/workflows/cost-guardian.yml`   | Daily cost enforcement                     |
| `docs/README.md`                        | Index of the documentation                 |

## Code Patterns

- **Go store interface**: all database access goes through a store interface
  (`GetStock(code)`, `GetTopShorts(period, limit, offset)`) for testability.
- **Connect-RPC handler**: `func (s *ShortsServer) GetStock(ctx, req
  *connect.Request[pb.GetStockRequest]) (*connect.Response[...], error)`; map a
  missing row to `connect.NewError(connect.CodeNotFound, err)`.
- **Server components fetch on the server** (`await getStock(code)` in a
  page); client data goes through TanStack Query (`useQuery` with a stable
  `queryKey`), and every ISR surface keeps a KV last-good layer (see Economy).
- **Never import `@connectrpc/connect` in a module that may be evaluated during
  SSR** (see Known Issues).

## Environment Variables

```bash
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts   # set by make dev
# Cloud features are fail-closed locally. Set an explicit project/bucket and
# use ADC only when the task genuinely needs GCP access.
GCP_PROJECT_ID=
GCS_LOGO_BUCKET=
ALGOLIA_APP_ID=1BWAPWSTDD                          # optional
ALGOLIA_SEARCH_KEY=0e5adba5fd8aa4b3848255a39c1287ef
OPENAI_API_KEY=sk-...                              # optional, enrichment
```

Production values are set in the Vercel dashboard and in Terraform for Cloud Run.

## Features

### Chat service (Shorted AI)

`services/chat-service/`: Go Connect-RPC with server streaming
(`SendMessageStream`), Gemini with 8 API tools, conversations in PostgreSQL
(migration 000026). Frontend: global `ChatSidebar` in the root layout plus
`/chat`; hook `web/src/@/hooks/use-chat.ts`; components
`web/src/@/components/chat/`. Auth is the `X-User-Id` header from the next-auth
session. Every chat component loads via `dynamic({ ssr: false })`.

### News aggregator

`services/news-aggregator/`: RSS feeds matched to ASX stocks; sentiment is
Gemini Flash batch analysis (`GEMINI_API_KEY`) with a keyword fallback;
`news_articles` with a 90-day TTL (migration 000029).

### Screener

`ScreenStocks` RPC (`screener.go`) over `mv_screener_data`
(`postgres_screener.go`); `/screener` page and `screener-widget.tsx`. The MV
COALESCEs unknowns to 0, which the MCP tools paper over; do not copy that.

### Strategies (`/strategies`, the stock picker)

Full record: **`docs/feature/strategies/README.md`** (pieces, data, jobs, every
landmine). Five strategies (`zanger-breakout`, `canslim`,
`minervini-trend-template`, `crowded-short-breakout`, `quality-compounders`)
over `StrategyService` (`strategies.proto`) and `StockService.GetStockFundamentals`.
The engine, spec, features, pipeline, pgsource readers, backtest and alert rule
language are pure Go under `services/pkg/strategy/`; the store is
`store/shorts/postgres_strategies.go` and `postgres_fundamentals.go`; the jobs
are `shorted picks` (daily 15:00 UTC: fundamentals, filings, refresh) and
`shorted strategies` (`-mode daily` snapshot, `-mode backtest` hourly, `-mode
parity`); filings come from `financial-report-extractor` (Python,
`services/report-extractor`). Web: `app/strategies/`, `components/picks/`,
`components/strategies/`, `lib/strategies/`. Every `/picks` URL answers 308 to
`/strategies`.

The rules that shape every change:

- **Every rule evaluates to pass / fail / unknown; unknown never counts as a
  pass** and blocks status `triggered`. Never COALESCE an unknown to 0; every
  nullable number travels with `has_*`.
- **The engine's constants and the v0 spec are pinned together**
  (`engine.TestV0SpecMatchesCode`). A threshold or weight change is a NEW rules
  version appended to the registry with a changelog entry, never an edit to v0
  (its hash is published). The five r1 recipes are frozen the same way
  (`recipe_hashes.golden` only gains lines).
- **A view change needs its Go port and its parity fixtures moved together**:
  `features.AsOf` and `features.Regime` port 000130's views; products that
  feed a comparison carry an explicit `float64(...)` (arm64 fuses `a*b+c`).
- **Fundamentals are in the company's REPORTING currency** and growth compares
  like spans only; Yahoo has NO half-year totals for ASX companies, halves come
  only from filings. FX-converted vendor statements are rejected field by field
  (`fx_converted`); price ratios need AUD statements AND one ordinary share per
  listed unit (`median_k` in [0.8, 1.25]); a CDI gets no P/E, never a number 10x
  off. Financials (banks, insurers, lenders) are decided ONCE in Go
  (`engine/fundamentals_quality.go`); every surface reads that list.
- **`services/pkg/extractiontrust` is the ONE funnel** for every reader of
  `financial_report_extractions.metrics` (the prompt's few-shot example was
  once published as five companies' results). A filing never overwrites a
  vendor value; `-mode filings` is a fail-closed rebuild in one transaction
  (exit 10 = refused, nothing written). A sign is never guessed.
- **000155 puts a trigger on `stock_fundamentals`** that writes a vintage row on
  every insert, changed update and delete, kept forever. Size a bulk rewrite
  before running it. Do not merge during 15:00-18:30 UTC or while
  `run_picks_job` runs; change `record_fundamentals_vintage` only through a
  later allowlisted migration.
- **The base is anchored** at the breakout session (pivot = the level cleared,
  length from the first touch); after a breakout the chart's base band ends at
  the breakout session, not the last close. A window is 40 sessions.
- **Every picks row is served three times**, so the server shortlist is capped
  at `SHORTLIST_MAX_ROWS` (10); the sort island gets `status_counts`, never the
  rows. **Signed-in depth never enters a cache**: the Signals island reads a
  signed-in viewer's list through `app/actions/strategies/viewer.ts` (identity
  only, no cache helper, a source-reading guard test). The public depth clamp
  is `STRATEGY_PUBLIC_SIGNALS_LIMIT` (prod 10).
- **`STRATEGY_SOURCE`**: `views` (prod today) serves the SQL views; `snapshot`
  serves the daily snapshot's newest complete session. The daily snapshot holds
  a session whose inputs are incomplete (a weekend-dated XJO bar included) and
  is dry-run unless `STRATEGIES_DRY_RUN=false`. The backtest job idles until a
  live canonical version other than v0 has a recipe; its publication gate is
  in the doc.
- **Saved strategies** (`user_saved_strategies`, 000157) are capped at 20 per
  user under an advisory lock; a cap hit is `PermissionDenied` with
  `X-Entitlement-Detail` `cap_reached`.
- The strategy chart primitives and returns kit (`StockChart` extensions,
  `ReturnsHeatmapTable`, `CoverageStrip`) are default-off and guarded by
  `colour-rules.test.ts` (no market red/green in the kit) and
  `client-boundary.test.ts`.

### Stock page (`/shorts/[stockCode]`, one route per tab)

Full record: **`docs/feature/stock-page/README.md`** (chrome, charts, the
readout, indicators, every landmine). A shared server `layout.tsx`
(breadcrumbs, `StockHeader`, sticky `StockTabNav`) with seven ISR pages beneath
it (3600 s; `/news` 600 s): `/`, `/short-interest`, `/strategy`, `/financials`,
`/company`, `/news`, `/community` (thread pages stay per-request). The tab list
lives ONCE in `web/src/@/lib/stocks/stock-tabs.ts`; tab metadata goes through
`lib/seo/stock-tab-metadata.ts`. Specs:
`docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md` and
`2026-10-10-stock-page-visible-first-design.md` (the second governs).

- **Every tab page exports `revalidate`, `dynamicParams = true` and an EMPTY
  `generateStaticParams`**, and nothing under the segment reads `searchParams`,
  `cookies()`, `headers()`, `auth()` or a no-store fetch. Three guards, each
  blind to something the others see: `web/scripts/route-kinds.mjs` (the
  prerender manifest), `app/shorts/__tests__/isr-source-safety.test.ts` (the
  segment's own files) and `ssr-import-safety.test.ts` (the static import
  walk; `KNOWN_CLIENT_CONNECT` can only shrink: an allowlist entry once sent the
  Financials route to 500 in production with every Jest test green). Client
  widgets that reach Connect load through a `"use client"` `*-loader.tsx`
  holding `nextDynamic(() => import(...), { ssr: false })`.
- **A transient stock read fails the render; it never degrades it.**
  `loadStockOrFail(code)` (`stock-page-data.ts`): unknown code = 404, a
  transient `undefined` throws, so a degraded shell is never cached for an
  hour. Do not add `app/shorts/error.tsx` (it would wrap the index too).
- **A price chart lives only on the tab it is about**, loaded through
  `components/charts/stock-chart-panel-lazy.tsx` (Overview, Short interest) or
  `strategy-levels-chart-loader.tsx` (Strategy): a real `import()` in a client
  module, so the chart is a chunk of its own. `web/scripts/stock-chart-chunks.mjs`
  (`task test:bundle`) fails when any other tab's manifest carries the chart.
- **Tab links prefetch on intent only**; never viewport prefetch (seven ISR
  regenerations per page view). Every link into a tab is `stockTabHref(code,
  tab)` with `prefetch={false}`.
- **An indexable page sets NO `robots` key** (Next merges metadata with `for
  (key in source)`, so `robots: undefined` wipes the root's googleBot
  directives). Old `?tab=` links are edge redirects
  (`web/src/config/stock-tab-redirects.mjs`); `?tab=overview` is deliberately
  not redirected (a same-path redirect loops).
- The sync revalidates `/shorts/[stockCode]` with type `layout`, which expires
  every tab for every code in one call. Every tab segment has a `loading.tsx`
  whose root is `role="status"`. The Company tab draws director trades on the
  server (an island that may resolve to nothing never holds a place it gives
  back). A missing community thread answers 200 with `noindex` (the segment's
  `loading.tsx` streams the layout first).

### Ownership (who holds ASX stocks)

Full record: **`docs/feature/ownership/README.md`**; spec
`docs/superpowers/specs/2026-11-02-ownership-explorer-design.md`. `/ownership`
(hub), `/ownership/[slug]`, `/ownership/stocks[/code]`, `/ownership/notices`, the
workspace (`/map`, `/connections`, `/activity`, `/funds[/fund]`, `/holders`,
`/changes`: one sub-nav, one toolbar row, one right-rail inspector driven by
`?sel=`), the Company tab's "Substantial holders" card and the Overview strip,
over `OwnershipService` (`ownership.proto`, 14 public rpcs). Fed by `shorted
ownership` (`services/jobs/internal/jobs/ownership/`: a curated registry of
~145 institutions, APRA, ASX's ETF/LIC report, index fund and super fund
holdings files, every substantial holding notice PDF since 2024). API handlers
assemble every response from ONE cached universe (`ownership_universe.go`);
the store reads empty on a schema without 000137. Web: `app/ownership/`,
`components/ownership/` (desk, workspace, funds, holders), `components/workspace/`
(the kit shared with Strategies), `lib/ownership/`. The insights explorer is
folded into the desk; `/ownership/insights` answers 308.

- **A notice is withheld rather than guessed** (scans, annexure-only figures,
  a name not on record, votes that do not fit ASIC's share count); never
  estimate a withheld figure. "Withheld" is eight outcomes, reported apart.
- **Notices overlap** (MUFG files for First Sentier, a bank for its manager),
  so every sum is "what the notices disclose", never a share of the company;
  say so wherever a sum is shown. A sum is never drawn against a 100% track.
  "Crowded" counts investors only (`institutionalKinds` excludes `bank_broker`).
- **"Current" means the newest notice we could read**, not held today; every
  holding row carries its notice date and an age cue past 90 days; an empty
  register reads "no notice read", never "no holder". Every figure carries its
  own date, never one page-level "as at".
- **Only per-holder history is drawn** (the Holder Lanes); a stock-wide or
  by-kind history would be guessing. Kinds are category colours, never market
  red or green; kinds and short interest never share one figure or panel.
- **Every workspace page is ISR** (exports `revalidate`, reads no
  `searchParams`; selection and window live in `?sel=` and desk params read by
  islands under their own Suspense). A new page goes into
  `OWNERSHIP_STATIC_ROUTES`, `isr-shell-pages.json` and `sitemap-sections.ts`.
  Every drawn element selects through the same `?sel=` grammar
  (`selection.ts`, parsed never trusted).
- **The rail leads with a computed sentence**, built clause by clause from
  figures it already shows; n/a is never 0. Company names are served clean
  (`cleanCompanyName`). `eventOf` classifies a notice's event ONCE in the store.
- **New rpc cost**: a new rpc needs the `shorts.proto` mirror; the web KV keys
  are versioned (`cache:ownership:*:v2`), so a new field read from an old entry
  is silently 0 for up to 21,600 s otherwise. The Overview strip's read is
  outside the critical path and reads no KV. The feed's weekly activity exists
  only on a first page.

### Weekly / monthly / yearly reports

LLM-generated reports at `/reports` (`2026-W23`, `2026-05`, `2025`; one
`weekly_reports` table). Generator `services/weekly-report-generator/` (Cloud
Run job + schedulers), read path `weekly_report.go` + `list_reports.go` (logos
hydrated at READ time, never stored), frontend
`web/src/app/actions/reports/getReportData.ts` → `web/src/app/reports/`.
**Generator struct json tags must exactly match proto snake_case field names**
(the API unmarshals JSONB straight into proto structs; `json_contract_test.go`).
Operating manual: `$weekly-reports` skill.

### Housing (tracker + suburb explorer + listings crawl + price-drops)

Five products over one data model and `HousingService` (`housing.proto`, 17
rpcs): the Widow-Maker editorial feature, `/housing` (ABS/RBA/Valuer-General),
the suburb explorer (`/housing/[state]/[suburb]`, "Colour by" metrics and
overlays), the residential listings crawl (REA/Domain via host-Chrome CDP on
residential Macs), `/price-drops`, and the council hub. **Live on prod.**
`house-price-collector` is a Cloud Run job (monthly, 5th 16:00 UTC).

**Docs: `docs/feature/housing/`** — start at `README.md` (`data-sources.md`,
`data-model.md`, `pipeline.md`, `operations.md`, `architecture.md`).

- Housing migrations are NOT in the deploy allowlist: apply DDL by hand before
  merging code that reads it, or every housing read path 500s. 000139's suburb
  reference views are the exception to DDL-first (apply only after the collector
  calls `refresh_suburb_reference_views()`).
- MV refresh on the session pooler only (`task db:prod:refresh WHICH=housing CONFIRM=prod`).
- Charts cannot SSR and functions cannot cross the RSC boundary: pass a
  serializable key, look the formatter up client-side. Reading `searchParams`
  in a server page silently forces dynamic rendering; read `?state=` client-side
  under a real `<Suspense>`.
- ABS WAF: `abs.go` MUST send `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)`
  and the SDMX CSV Accept header. Do not hand-set a UA on the crawl tier.
- Crawl rows are never republished raw (`source_licence='proprietary-tos-restricted'`
  is a column DEFAULT); only derived aggregates are publishable. A hand-run crawl
  writes nothing (`CRAWL_DRY_RUN` defaults true). Crawl throughput
  (`CRAWL_DELTA_MAX_SUBURBS` 120) and its alarm (`CRAWL_FRESHNESS_ALARM_HOURS`
  120h) are ONE decision; judge a run by SUCCEEDED jobs, never "processed".
- The sentinel (`housing-freshness.yml`, GitHub-hosted) is the only alert layer
  that survives a dead rig. The rig is a hand deploy: `deploy/stage-rig.sh --check`
  first in any crawl incident.

### Economy (map explorer + state pages + series platform)

`/economy` → `/economy/[state]` over `economic_series` + `economic_observations`
(000081-000085) fed by `shorted economy` (11 sources, monthly Cloud Run job,
5th 17:00 UTC), read by `EconomyService` (`economy.proto`). **Live on prod.**
Full architecture and extension recipes: **`docs/economy-architecture.md`**;
operations: `$economy-data` skill.

- The `next:{revalidate}` tag on server-action connect transports is
  LOAD-BEARING for ISR (untagged → no-store → "static to dynamic" throw); the
  Upstash KV last-good layer in `getEconomy.ts` is the durable protection.
  Mirror it for new ISR surfaces. After every deploy, run the revalidate sweep.
- ABS reality: no GSP or GFS SDMX flows (SFD proxy + GFS XLSX importer); never
  derive series keys from source labels. Prod `company-metadata` lacks
  `sector`/`description`; query only columns present in both.
- `services/pkg/absdata/` is the shared ABS/RBA client; the WAF-safe UA is mandatory.

### Politicians: register of interests ("Parliament's Portfolio")

What federal MPs and senators declare, from the APH registers. **Live on prod.**
`/politicians`, `/politicians/[slug]`, `/changes`, `/short-interest`, cards on
stock, suburb and state pages, admin consoles under `/admin/register/`. Jobs
`shorted influence -mode register-*`, all default `REGISTER_DRY_RUN=true` and
excluded from `-mode all`. **Docs: `docs/feature/politicians/`** (start at
`README.md`; `architecture.md` §8.x before touching resolution logic). Editorial
gate: `docs/influence-editorial-standards.md`.

- **What is held, never how much** (no amount column exists; a migration test
  asserts it). **Extracted facts are publishable, source artefacts are not**
  (portraits from Wikimedia Commons, never aph.gov.au; LinkedIn is permanently
  out). **Withhold rather than guess.** APH is CC BY-NC-ND: never rewrite an
  APH prose string. Portrait attribution is a licence obligation enforced in
  four places.
- Migrations are hand-applied before merge. `run-tests` gates the DEPLOY, not
  the PR; golangci-lint runs in no CI job. `compliance.tsx` imports generated
  protobuf: never import it from a client component (use
  `@/lib/politics/party-palette`). Slugs are minted once; a merge retires a row
  via `merged_into_id`. A new House `source_url` is a SUCCESSION, never a fresh
  member (`superseded_by`, 000123).

### MCP server (`/mcp`, OAuth 2.1, 32 tools)

Full record: **`docs/mcp-server.md`** (key files, every landmine);
`docs/mcp-admin.md` (the admin server, `/mcp/admin`);
`docs/superpowers/handover-2026-08-29-mcp-oauth.md`. The Go API is BOTH the
resource server and the authorization server (HS256 with a symmetric secret);
Next.js contributes only the consent screen (`web/src/app/oauth/authorize/`).
Code: `services/shorts/internal/mcp/` (server, registry, tools, `auth.go`,
`ratelimit.go`), `services/shorts/internal/oauth/`, migration 000116 (replayed
every deploy; every statement `IF NOT EXISTS`).

The product promise: a user adds the URL to Claude or ChatGPT and the client does
the rest. **Anonymous access must keep working**; OAuth raises limits and
identifies a caller, it is never a gate on first contact, and no tool is
reserved for a paid plan.

- **The ONLY place we challenge is the ceiling**: an anonymous caller at their
  quota gets a **401** with the RFC 9728 challenge (clients branch on the
  status; a 429 is a transport failure to all of them); an authenticated caller
  at their ceiling gets a plain 429 with `upgrade_url`.
- **A grant needs a CONSENT TICKET, not just an identity** (mintable only via
  `POST /oauth/consent/ticket` behind `INTERNAL_SERVICE_SECRET`; single-use,
  bound to user + client + redirect URI + PKCE + resource + scope, all six
  re-checked). Do not require a Firebase ID token in the browser (optional
  cross-check only). Loopback redirect URIs ignore the port and nothing else.
- **Tier is not a scope.** Every scope names a data domain and is read-only,
  except `alerts:write`, the one write scope (the signed-in user's own alerts,
  served only to a VERIFIED token carrying it: `HandlerWithAlerts`; anonymous
  callers see the `manage_my_alerts` discovery tool, whose call is the sign-in
  challenge). Any other write tool needs its own documented decision. Admin
  scopes are separate, checked PER TOOL; the HTTP layer requires at least one.
- **Never publish a ceiling you do not enforce**: the catalog reads
  `rateLimits.enforced` from the running config and derives numbers from
  `ratelimit.DefaultConfig`.
- **Tools call `ShortsServer` IN PROCESS**, skipping the interceptor chain, so
  they are constrained to `VISIBILITY_PUBLIC` methods and rate limiting is its
  own HTTP middleware, composed INSIDE the bearer middleware.
- **`Stateless: true` is load-bearing** (without it the SDK negotiates down to
  legacy `initialize`); `mcp.StreamLifetime` is 90 s, under Cloudflare's 120 s
  and Cloud Run's 300 s (every `/mcp` 5xx on 2026-09-10 was a listen stream
  held to 299.98 s). `/mcp` is never cached (edge bucket `mcp-anon`).
- `encoding/json` refuses `±Inf` where protojson does not: guarded at the write
  funnel (`services/pkg/keymetrics/finite.go`). The SDK inlines every nested
  struct, so `tools/list` is ~97 KB against a 101,376 B budget: fewer fields,
  never flattening. The `/oauth/` routes render without site chrome on purpose.

### Scheduled jobs on Kubernetes (Paprika on omega VKE, Telesis monitoring)

Scheduled batch jobs are moving from Cloud Scheduler → Cloud Run Jobs to
Kubernetes CronJobs on the omega VKE cluster: **`deploy/kubernetes/jobs/`**
(chart + Paprika Application + scripts; runbook in its `README.md`). Paprika
renders the chart into namespace `shorted-jobs`; the `shorted cronjob-reporter`
Deployment turns every Job's lifecycle into Telesis cron-monitor check-ins, which
alert on failed, missed and timed-out runs. The job-monitoring email channel also
notifies the shorts API uptime alerts (`terraform/modules/shorts-api/uptime.tf`),
so keep `ALERT_RECIPIENT_EMAIL` set.

- **Cutover is two lists that must match**: `enabled:` in
  `deploy/kubernetes/jobs/chart/values.yaml` and `local.jobs_on_vke` in
  `terraform/environments/prod/main.tf`. One without the other runs a job twice
  or not at all (`scripts/tests/vke-jobs-cutover.test.mjs`).
- **Cloud Run jobs are NOT deleted** (admin Run now, validation runs, rollback
  still use them). Until a job's Cloud Run definition is retired, change its
  args/env/timeout in BOTH `values.yaml` and Terraform; an execution matches its
  Telesis monitor only by exact args and env.
- Cloud Run env is emulated: `CLOUD_RUN_EXECUTION` = the Job name,
  `CLOUD_RUN_TASK_ATTEMPT` = the Indexed Job's per-index failure count, so Jobs
  stay `completionMode: Indexed` + `backoffLimitPerIndex`.
- **Paprika tracks the `deploy/vke-jobs` branch, not main**: the deploy's
  `bump-vke-jobs-image` job moves it only after Terraform applies, so a CronJob
  never goes live before its Cloud Scheduler trigger is paused. Never promote
  that branch to an unverified tag by hand.
- An ERROR log with exit 0 no longer pages: exit non-zero
  (`runner.ExitCodeError`) if a path should alert. Telesis project tokens cannot
  register cron monitors (`register-monitors.py` needs `telesis login`). Keep
  CronJob names matching their old trigger names, or the admin job monitor
  overlay (`jobmonitor/cluster.go`) cannot find them.
- `shorted-key-metrics` (VKE-native, daily 19:40 UTC) refreshes
  `"company-metadata".key_metrics` from Yahoo; the `SyncKeyMetrics` RPC is retired.

### Blog MDX palette

`/blog` posts (`web/_blogs/*.mdx`) use one component map
(`web/src/@/components/blog/mdx-components.tsx`); editorial figures
(`Callout`, `Quote`, `Steps`, `GraphStat`, `GraphRank`, `GraphTable`) live in
`web/src/@/components/mdx/article-figures.tsx` and render semantic HTML on the
server. Extend them; do not import or vendor mdxcn figures. `next-mdx-remote` v6
blocks JavaScript expressions (`blockJS: true`), so data goes in JSON string
attributes (`items='[{"label":"Fawkner","value":29.7}]'`, `max="30"`), never
`items={[...]}`. `BLOG_MDX_FIGURES` lists every name a post may use. Guidance:
`docs/article-mdx.md`, `docs/article-design.md`, `docs/blog-thumbnail-directions.md`;
cover art via the `shorted-editorial-art` skill, card assets via
`web/scripts/editorial-thumbnails.mts`. The newsroom palette
(`components/news/mdx/`) is separate (`$newsroom`).

### Share & embed (charts and widgets)

Full record: **`docs/share-embed.md`**. Every embeddable widget carries a Share
button (`components/ui/embed-dialog.tsx`): a link, the native share sheet, and
copy per destination (`lib/embed/share.ts`); only Website is the HTML snippet
(chat apps show HTML as text). The chart share page is `/chart/<CODE>` (noindex,
no chrome), its card `/chart/<CODE>/image` (1200x630, never a 500), landscape
mode turns the box with CSS on a portrait phone, and the indicators registry is
`components/charts/chart-indicators.ts`.

- A chart as posted takes `?asof=&shorts=&prices=` (`chart-anchor.ts`); a
  settled anchored card is CDN-cached 30 days.
- `/chart/` must stay out of robots.txt and `/embed/` in it
  (`robots-rpc-disallow.test.ts`). The card's Cache-Control key is lowercase.
- Never wrap a Discord link in angle brackets; tickers are `ASX:CODE` on X,
  LinkedIn and Reddit.
- Nothing that positions with floating-ui may render inside the landscape box
  (the indicator menu is CSS-positioned inside the chart box); the box hears
  Escape on `window` last and ignores a `defaultPrevented` one.
- `chart-indicators.ts` imports only types from `chart-views.ts` and has no
  `"use client"` (server code reaches it through `chart-views.ts`).

### Discord bot (slash commands, live charts, Activity)

Runbook and every landmine: **`docs/discord-bot.md`**. An HTTP interactions
endpoint (`web/src/app/api/discord/interactions/route.ts`, Ed25519-signed),
deployed with the web app. Commands `/stock`, `/chart`, `/search`, `/top`,
`/settings`, `/help`. A chart message is the `/chart/<CODE>/image` card plus
button rows that redraw it in place and an **Interactive** button that opens
`StockChartEmbed` inside Discord as an Activity (`/embed/discord`). The app id
and public key are committed in `web/src/config/discord-app.json`; `task
discord:setup|status|register`; public page `/docs/discord`.

- **Buttons carry their chart in `custom_id`**; old messages keep sending what
  they were posted with. Add kinds, never change one. A chart message uploads
  its card in the deferred webhook edit (the bot FETCHES it from
  `/chart/<CODE>/image`; rendering in the function is the fallback).
- **The Activity loads `/`**: Discord's proxy opens the root with `frame_id`
  and `instance_id`, and the root layout's inline `discordActivityHeadScript`
  in `<head>` moves the address to `/embed/discord` before the router reads it
  (a static inline script, nothing else works under the proxy's nonce). Inside
  the Activity only same-origin requests work, nothing may navigate the frame,
  and it renders no `<a>` at all (links go out through the SDK).
- `/api/discord/` and the Activity (`/embed/discord` and `/` with both
  `frame_id` and `instance_id`) are in the Cloudflare SBFM skip; the signature
  check keeps the route closed. Proxy auth headers are a session pass, not
  request signing: never let them authorise a write alone.
- A `/settings` link is a 30-minute bearer grant signed from `NEXTAUTH_SECRET`.
  `@vercel/functions` stays on 1.x.

### Twitter / X automation

`@shorted___`. A Node + TypeScript project at `scripts/twitter/` (entry
`src/index.ts`; templates, client, API wrapper beside it). Runbook:
`scripts/twitter/OPERATIONS.md`; brand: `PROFILE.md`. Local cron is the
production path; the GitHub workflow is manual-only.

- OAuth 2.0 PKCE credentials in the repo-root `.env`: `TWITTER_CLIENT_ID`,
  `TWITTER_CLIENT_SECRET`, `TWITTER_REFRESH_TOKEN` (minted by
  `npx tsx src/index.ts bootstrap-oauth2`; callback `http://127.0.0.1:8787/callback`;
  scopes `tweet.read tweet.write users.read offline.access`). **The refresh
  token is rotated by X on every use** and written back to `.env`; never edit it
  by hand. OAuth 1.0a keys are the fallback.
- Dry run is the default (`TWITTER_DRY_RUN_DEFAULT=true`); `--live` posts.
  Commands: `daily-shorts`, `movers`, `stock-of-the-day`, `weekly-digest`,
  `breaking-news`, `insider-trade --stock=BHP`.
- Rapid bursts to `api.shorted.com.au` trip the Cloudflare edge rule; trusted
  tests use the testing bypass (both the UA and the secret header, see Rate
  Limiting). If every productCode returns the same stock, check
  `buildHotCacheKey` in the edge worker hashes the POST body.

### Short-interest alerts (`shorted alerts`)

Monitors created on `/alerts` are evaluated by `shorted alerts`, a VKE CronJob
(`shorted-alerts`, hourly on weekdays at :55 UTC) that emails entitled owners
through Resend, one email per event with a signed one-click pause link. Code
`services/jobs/internal/jobs/alerts/`; contract `services/pkg/alertevents`;
runbook **`docs/alerts-runbook.md`**.

- VKE-native, no Cloud Run twin (a second path would be a second way to send
  customer email). Dry run unless `ALERTS_DRY_RUN=false`.
- The newest ASIC sync must have completed (the gate reads only the ASIC
  recorder's `sync_status` rows); every unevaluated date is held (exit 10)
  until one lands; a running sync under two hours old makes the run wait.
- Alert tokens are `alert-monitor:<id>` signed with `UNSUBSCRIBE_SECRET` and
  never expire; rotating the secret needs `sync-secrets.sh` AND a new shorts API
  revision. Entitlement (`ACTIVE`, `TRIALING`) is pinned to the API's
  `ResolveEntitlement`. `SHORTS_API_URL` is the Cloud Run origin, never
  `api.shorted.com.au`.
- Only a verified address is emailed, enforced in the API
  (`Claims.EmailVerified` set by the interceptor only). Active monitors are
  capped at 50 per user; pausing is never refused.

## Known Issues & Gotchas

### SSR Issues with @connectrpc/connect Imports (CRITICAL)

A direct import from `@connectrpc/connect` (or `@bufbuild/protobuf`) in any
module evaluated during SSR fails every route with
`Element type is invalid: expected a string ... but got: undefined`, even from a
`"use client"` component that a server component transitively imports
(`layout.tsx → ThemeProvider → QueryClientProvider → retry.ts → @connectrpc/connect`).
Use duck-typing for error handling instead of the import:

```typescript
const CODE_RESOURCE_EXHAUSTED = 8;          // gRPC/Connect standard code
function isConnectErrorSync(e: unknown): e is { code: number; message: string; metadata: unknown } {
  return e !== null && typeof e === "object" && "code" in e &&
    typeof (e as Record<string, unknown>).code === "number" && "message" in e && "metadata" in e;
}
```

`web/src/@/lib/retry.ts` is the fixed example. Keep Connect imports in
client-only API call files; the `client-boundary.test.ts` guards (politicians,
ownership, strategies) and `ssr-import-safety.test.ts` enforce it.

### Firebase Admin SDK: lazy initialization (CRITICAL)

`firebase-admin.ts` initializing at module scope crashes `next build` when CI
provides a dummy private key (`Failed to parse private key`). Use Proxy-based
lazy getters that initialize on first access, casting through `unknown`
(`as unknown as Record<string | symbol, unknown>`) or TypeScript rejects the cast.

### CORS: Next.js rewrites, not backend CORS headers

Client-side RPCs proxy through `rewrites()` in `next.config.mjs`
(`/shorts.v1alpha1.<Service>/:path*` → the Cloud Run URL); client code uses
relative URLs, server code the full backend URL.

### Vercel environment variables: escaped newlines

Vercel project-level env vars can have literal escaped newline suffixes baked
into JS bundles. `.trim()` is not enough for client-side Firebase config; use
`normalizeFirebasePublicConfigValue` in `firebase-public-config.ts`. Production
releases must run `npm --prefix web run firebase:preflight` before build and the
Firebase Google sign-in bootstrap check in release smoke. The failure signature
is `API_KEY_INVALID` from `identitytoolkit.googleapis.com` before `/api/auth` is
reached. See `docs/FIREBASE_AUTH_VALIDATION.md`.

### Smaller ones

- **Cloud Run**: every service needs `startup_probe` and `liveness_probe` on
  `/health` in Terraform (copy an existing module), or "Error code 9: container
  failed startup probe checks".
- **Jest**: `firebase-admin/app` and `firebase-admin/auth` need explicit mocks
  in `setup.ts`; `jwks-rsa` bundles `jose` in nested `node_modules/` (add both to
  `transformIgnorePatterns`); `withRetryAndNotFound` returns `undefined` for ALL
  errors (expect `toBeUndefined()`).
- **Pre-commit**: `golangci-lint` needs `--concurrency 1 --timeout 120s` (OOM
  otherwise; set in the Makefile). `make build-frontend` may fail locally when
  pages prerender against `api.shorted.com.au` (TLS mismatch): an environment
  issue, not a code issue.
- **GitHub Actions WIF**: `google-github-actions/auth@v2` needs
  `permissions: id-token: write` at the workflow level.
- **Vercel root directory is `web/`**: deploy from the repo root, not from `web/`.
- **Git worktree**: `main` may be checked out elsewhere; use
  `git branch fix-name origin/main` instead of `git checkout main`.

### React 19 / Next 15 (the web app's upgrade, 2026-11)

Full record and measurements: **`docs/web-react19-next15.md`**.

- **Production runs Next's bundled React** (`19.2.0-canary-...` in 15.5.28), not
  the `react` 19.2.9 in `package.json`; only a browser run against `next start`
  exercises it. Next is the 15.5 line; Next 16 removes the synchronous request
  APIs, `next lint` and `publicRuntimeConfig`, so it is a separate upgrade.
- **Request APIs are async**: `cookies()`, `headers()`, `params`, `searchParams`
  are awaited, never read as plain objects.
- **Lint runs on the ESLint CLI** (`npm run lint` over `app pages components
  lib src`), not `next lint`; `scripts/tests/web-lint-cli.test.mjs` forbids any
  caller of the old command. `next build` still lints in 15.5; when upgrading
  to 16 add a CI lint step.
- **The build identity is baked in**: `/api/version` reads literal
  `process.env.SHORTED_BUILD_*` and `NEXT_PUBLIC_RELEASE_COMMIT` passed through
  `env` in `next.config.mjs` from `src/config/build-identity.mjs`; a dynamic
  lookup is not inlined and reads `local`.
- `experimental.staticGenerationMaxConcurrency: 1` (a failed call during the
  prerender bakes the fallback page; re-measure before raising) and
  `experimental.staleTimes: { dynamic: 30 }` (the browser's requests count
  against the rate limits). `htmlLimitedBots: /.*/` resolves metadata before
  the shell, or title, canonical and robots land in `<body>` on dynamic pages.
- **A `next` option on a POST stays out of Next's data cache.** Next 15 keys
  byte bodies, so a tagged Connect POST would store an empty answer for the
  whole window. `serverFetchWithUserAgent` (config.ts) sends such requests
  around the patched fetch and registers the policy through `unstable_cache`;
  reads that many renders share take `sharedRead` (actions/shared-read.ts),
  which throws on an empty answer so only a good one is held. Do not add a
  static `next/cache` import to config.ts.
- **The warm-cache routes** (`api/*/warm-cache`, `api/warm-pages`) are
  `force-dynamic` behind `isCacheWarmAuthorized`: the `CRON_SECRET` bearer, the
  `REVALIDATION_SECRET` bearer or `X-Cache-Warm-Secret`; never a query-string
  secret. On Vercel with nothing configured they refuse everything.
- **`next/dynamic` with `ssr: false` belongs in a client module**; Next 15
  refuses it in a server component. React 19 resets an uncontrolled form once
  its `action` completes, so the admin trigger form submits through `onSubmit`
  and clears its fields only when a job was created.
- `next-auth` beta.32's Edge warnings (`jose` 6 `deflate.js`) are expected; a
  new Edge warning not pointing at that module is real. Image routes honour
  their `revalidate` export now. IBM Plex Mono is the app face
  (`--font-plex-mono`, `adjustFontFallback: false`).
- **visx 4**: measure charts with `ParentSize` from
  `@/components/charts/parent-size`, never `@visx/responsive` (its box collapses
  content-sized wrappers to 0px); no deep `lib/` imports (the `exports` map
  refuses them at runtime while `tsc` passes); declare every visx package the
  app imports; do not add `@visx/xychart` back.

## Debugging

```bash
make clean-ports && make dev-stop && make dev    # backend not starting
make dev-db; docker ps                           # database connection issues
make clean-cache; cd web && rm -rf node_modules && npm install   # frontend build errors
docker info; cd services && go test -v ./test/integration/...    # integration tests
```

**Production 500s after a deployment**: use `$shorted-prod-troubleshooting`
first (release smoke, Vercel logs, Cloudflare Worker/wrangler diagnostics, API
edge checks, RUM, data freshness). Then: `vercel logs --follow`; "Element type
is invalid" means an SSR import issue (above); roll back with `npx vercel ls`
and `vercel promote <deployment-url> --yes`; binary-search `layout.tsx` on a
preview URL to find the component whose import chain reaches `@connectrpc`.

## Infrastructure

- **GCP project** `rosy-clover-477102-t5` (production; explicit operations
  only), region `australia-southeast2`, Artifact Registry
  `australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted`.
- **Database** Supabase (prod), Docker PostgreSQL (dev). **Frontend** Vercel
  behind Cloudflare (the edge gateway is described in `AGENTS.md`).
- **Terraform**: `terraform/environments/prod` (`terraform init && terraform
  plan`; apply only through the reviewed deployment workflow).
- **Gemini and bypass deploy secrets live in Cuttlefish, not GitHub**: the
  deploy jobs run on Cuttlefish runners and read `secrets.GEMINI_API_KEY*` and
  `secrets.CLOUDFLARE_*_BYPASS_SECRET` from its project store. Set one with
  `printf '%s' "$VALUE" | cuttle secrets set NAME --project shorted` (stdin,
  never `--value`), after `cuttle login --project shorted`; an
  `--environment <env>` copy is read before the project copy. The one
  GitHub-hosted reader is `rate-limit-sentinel.yml`.
- **Gemini keys are validated before they sync** (`scripts/validate-gemini-key.sh`
  makes a real generation call; `models.list` proves nothing). A rotation
  touches every copy: Cuttlefish (`GEMINI_API_KEY`, `SHORTED_GEMINI_API_KEY`),
  Secret Manager (`GEMINI_API_KEY`, `_CHAT`, `_NEWS`, `_REPORT_EXTRACTOR`) and
  the VKE jobs (`deploy/kubernetes/jobs/scripts/sync-secrets.sh`, `CONFIRM=prod`).
  Change Cuttlefish first. While `GEMINI_API_KEY_CHAT` is unset in Cuttlefish,
  every deploy writes the shared key into Secret Manager's `_CHAT`.
- **Cross-repo**: the repo-root `.env` Cloudflare creds (`TF_VAR_cloudflare_email`
  + `TF_VAR_cloudflare_global_api_key`) also feed cuttlefish's shared-droplet
  Terraform for the `telesis.dev` zone. Don't rotate or remove them without
  updating that stack (`~/projects/cuttlefish/DROPLET.md`).

## External Services

| Service   | Purpose               | Config Location                    |
| --------- | --------------------- | ---------------------------------- |
| Supabase  | Production PostgreSQL | `web/.env.local`                   |
| Algolia   | Search index          | `services/Makefile`                |
| Firebase  | Authentication        | `web/src/@/lib/firebase-client.ts` |
| GCS       | Logo storage          | Terraform                          |
| Cloud Run | Backend hosting       | Terraform                          |
| Vercel    | Frontend hosting      | `web/vercel.json`                  |
| Upstash   | Page cache (Redis)    | Environment variables              |
| Resend    | Alert email           | VKE job secrets                    |

## Rate Limiting

Operator reference and debugging runbook: **`docs/rate-limiting.md`**. Design
record (the incident, the edge buckets, the monthly accounting, the 429 payload
in full): **`docs/rate-limiting-design.md`**. Edge layer:
`services/edge-worker/README.md`. The numbers live in
`services/pkg/ratelimit/config.go` (`DefaultConfig`); the published tables in
`api-key-manager.tsx` and `/docs/api` are held to it by
`api-key-manager-quota-contract.test.ts`.

Rate limiting is **split across three failure domains on purpose**:

| Concern | Where it runs | Depends on |
|---|---|---|
| Tier-blind **abuse ceiling** | Cloudflare edge worker (`services/edge-worker/worker.js`) | Cloudflare only |
| **Per-tier per-minute** limiting | Go API (`services/pkg/ratelimit/minute.go`), in process, per instance | nothing |
| **Monthly** quota accounting | Go API (`monthly.go`) | Postgres `api_usage_monthly` (000112, replayed every deploy), batched |
| Zone-level DDoS/abuse limit | Cloudflare zone ruleset (Terraform) | Cloudflare only |

**The rate-limit path touches Upstash zero times.** In August 2026 a 7-command
Upstash pipeline per request, on the database that backs the page cache, burned
the command cap, and Upstash rejected writes while serving reads: one quota, two
outages. Three load-bearing rules came out of it: rate limiting must not depend
on Upstash at all (a test asserts no `RATE_LIMIT_UPSTASH_*` env vars exist);
quota accounting must not become a second capacity problem (it reuses the
store's `pgxpool`, does no I/O on the request path, flushes one multi-row
upsert); and **a sick quota database must never 429 or 500 a user** (fails open
unconditionally, retains deltas, trips a breaker). `RATE_LIMIT_ENABLED=true` is
the only switch, and it is on in prod.

**Tiers** (API access by token: anonymous 30/min and 500/month, free 60 and
1,000, paid 120 and 10,000, enterprise 300 and 50,000; browser access: anonymous
60 and 5,000, free 120 and 10,000, paid unlimited). Per-minute is per Cloud Run
instance (tier shaping; the edge is the hard ceiling); a per-minute rejection
does not consume monthly quota; anonymous callers are unmetered monthly by
default. A limit of `0` means unlimited and its headers are omitted.

**The edge is deliberately tier-blind** (buckets `k:<token hash>` 100/10s +
600/60s, `a:<ip>` 10/10s + 30/60s, `f:<egress ip>` 600/10s, browser buckets that
are dead code until a `shorted.com.au/*` worker route exists). Verified search
crawlers are never limited anywhere. `/api/auth/*` is exempt. Every edge 429
carries `X-RateLimit-Bucket`; `api-anon` 429s at volume mean the first-party
marker is not reaching the worker.

**We never rate limit ourselves.** Vercel performs the rewrite, so the worker
sees a shared egress IP. `web/src/middleware.ts` stamps the `x-shorted-ssr-bypass`
secret and APPENDS `shorted-web-ssr` to the user agent; the worker and the Go
interceptor (`classifyFirstParty`) route that into the `first-party` bucket, and
an unverifiable marker is STILL first-party (`first-party-unverified`, 600/10s;
the secret buys only monthly metering, never per-minute headroom). Between
2026-08-22 and 08-23 CI's prerender, unable to read the sensitive var, took
7,045 self-inflicted 429s and baked fallback data. Corollaries: CI `vercel
build` steps are handed `SHORTED_SSR_BYPASS_SECRET` explicitly (export-only);
`SHORTS_SERVICE_ENDPOINT` must reach every build; every server-side Connect
transport uses `serverFetchWithUserAgent` / `serverFetchOutsideNextCache`
(`serverApiSurface.test.ts`). Change the marker in one layer and you must change
the other.

**Identifying the caller takes BOTH layers.** The worker strips client-supplied
`cf-connecting-ip` / `x-forwarded-for` and re-adds Cloudflare's own
(`filterRequestHeaders`); the origin believes them only when the rightmost hop
is a published Cloudflare address (`resolveClientIP`). With either half missing
every identifier in `api_usage_monthly` is a Cloudflare address and a whole colo
shares one bucket. A deploy succeeding proves nothing here: snapshot the table,
wait a flush cycle, diff.

**The 429 contract.** Every app-layer rejection is a Connect
`resource_exhausted` whose metadata carries JSON under `X-RateLimit-Detail`
(`kind`, `limit`, `used`, `remaining`, `reset_at`, `retry_after_seconds`,
`tier`, `access`, `upgrade_url`, `message`; Go type `ratelimit.RateLimitDetail`,
**field names are a contract**), mirrored in individual headers. `access`
(`api` | `browser`) is load-bearing for the upgrade copy: paid browser is
unlimited, paid API is a real ceiling (`rate-limit-access-promise.test.tsx`).
An edge 429 carries no detail: frontends branch on its presence.

### Cloudflare Edge Test Bypass

The zone rule and the worker both skip a request carrying BOTH
`User-Agent: Shorted-E2E/1.0` and `X-Shorted-Testing-Bypass: <secret>`
(`TF_VAR_rate_limit_testing_bypass_secret`; empty disables). Never make it
UA-only. Browser tests send it to our own origins and localhost only (import
`test` from `web/e2e/helpers/test.ts`); never put it in Playwright's
`extraHTTPHeaders`, which go to every host a page contacts.

### Cloudflare SSR Bypass

Same shape for our own SSR: `shorted-web-ssr` UA marker + `x-shorted-ssr-bypass`
secret (`TF_VAR_rate_limit_ssr_bypass_secret`, also delivered to the worker as
`RATE_LIMIT_SSR_BYPASS_*` bindings and to Cloud Run by the `shorts-api` module).
`web/src/app/actions/config.ts` attaches it in `serverFetchWithUserAgent` only
when `SHORTED_SSR_BYPASS_SECRET` is set AND the request targets a shorted API
origin; it is never `NEXT_PUBLIC_*`. Rotate all four copies together:

```bash
SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
printf '%s' "$SECRET" | cuttle secrets set CLOUDFLARE_SSR_BYPASS_SECRET --project shorted   # the deploy reads this one
printf '%s' "$SECRET" | gh secret set CLOUDFLARE_SSR_BYPASS_SECRET --repo castlemilk/shorted.com.au   # the sentinel
printf '%s' "$SECRET" | vercel env add SHORTED_SSR_BYPASS_SECRET production
# then re-run terraform-deploy
```

Terraform/Cloudflare first, then Vercel: the worst case is a brief window of
rate-limited SSR, never an outage.

### Cost attribution

Cloudflare RUM is the zone's automatic Web Analytics injection (Terraform
`cloudflare_zone_setting.web_analytics_rum`); the app component
`cloudflare-web-analytics.tsx` is a disabled-by-default fallback that must post
to the same-origin `/cdn-cgi/rum`. Field contracts:
`docs/observability/cost-attribution.md`.

## Git Workflow

```bash
make test             # before pushing
make install-hooks    # the pre-push hook
```

### A merge is not a deploy until its deploy has run

Every push to `main` deploys through `terraform-deploy.yml`, which Cuttlefish
runs (the workflow is disabled on GitHub). `deploy-vercel-prod` builds and
promotes the whole of `main` on every push, no path filter. The concurrency
group is `deploy-refs/heads/main` with `cancel-in-progress: false`, so a push
that lands during a deploy is QUEUED and shows nothing in `cuttlefish_runs_list`
until the running one finishes; a newer push replaces a queued one. On
2026-10-19 the queue's release was lost and production stayed on the earlier
merge for nearly three hours with every check green (fixed in
`skunkworq/cuttlefish` PR #508). After a merge, a `gha-terraform-deploy-*` run
for the merge commit appears within a minute, or as soon as the running deploy
finishes. If none ever starts:
`cuttle gha dispatch castlemilk/shorted.com.au terraform-deploy.yml --ref main --project shorted`.

## Versioning

Git-based: `web/scripts/bump-version.sh` generates versions like
`v0.2.2-748-g032f59db` on each frontend build, displayed in the app. Always
commit changes to keep the version info current.
