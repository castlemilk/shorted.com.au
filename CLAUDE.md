# CLAUDE.md - Project Context for AI Assistants

This file provides context for AI coding assistants (Claude, Cursor, etc.) working on the Shorted.com.au codebase.

## Quick Start

`task` is the front door — `task --list` shows the everyday operations, grouped
so the list reads as a risk map (anything under a `prod:` segment writes to
production and requires `CONFIRM=prod`). The Makefiles still exist and still
work; the Taskfile curates the ~40 operations people actually reach for and
pins the things that are dangerous to get wrong:

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
# First time setup
make install

# Start development (database + backend + frontend)
make dev

# Run all tests (lint + build + unit + integration)
make test

# Stop everything
make dev-stop
```

## Project Overview

Shorted.com.au is a platform for tracking short selling positions in the Australian stock market. It ingests daily ASIC short selling data, enriches it with company metadata, and provides a dashboard for users to analyze short positions.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│                    Next.js 14 (port 3020)                           │
│              TailwindCSS, Radix UI, Visx Charts                     │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ Connect-RPC (HTTP/2)
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Backend Services                             │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  Shorts API      │  Market Data     │  Chat Service                  │
│  Go (port 9091)  │  Go (port 8090)  │  Go + Gemini LLM              │
│  Main API        │  Stock prices    │  AI chat + streaming           │
├──────────────────┴──────────────────┴───────────────────────────────┤
│  Enrichment Processor  │  News Aggregator  │  Daily Sync             │
│  Go + GPT-4            │  Go + Gemini Flash│  Scheduled data updates  │
└──────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       PostgreSQL (port 5438)                         │
│              Tables: shorts, company-metadata, stock_prices          │
└─────────────────────────────────────────────────────────────────────┘
                      ▲
                      │ Daily sync
┌─────────────────────┴───────────────────────────────────────────────┐
│                       Data Pipeline                                  │
│           ASIC CSV files → Python processing → Database              │
│           Cloud Run Jobs (scheduled 2 AM AEST)                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Services

| Service          | Port | Directory                        | Description                                    |
| ---------------- | ---- | -------------------------------- | ---------------------------------------------- |
| Frontend         | 3020 | `web/`                           | Next.js app with dashboard, stock pages        |
| Shorts API       | 9091 | `services/shorts/`               | Main API for short position data               |
| Market Data      | 8090 | `services/market-data/`          | Historical stock prices                        |
| Chat Service     | -    | `services/chat-service/`         | AI chat with Gemini LLM + 8 API tools          |
| News Aggregator  | -    | `services/news-aggregator/`      | RSS news aggregation + Gemini sentiment        |
| Enrichment       | -    | `services/enrichment-processor/` | AI-powered company metadata                    |
| Jobs monolith    | -    | `services/jobs/`                 | `shorted <job>` — scheduled jobs incl. ASIC sync |

## Development Database

```
Host:     localhost:5438
Database: shorts
Username: admin
Password: password
```

Connection string: `postgresql://admin:password@localhost:5438/shorts`

## Database Schema

### Core Tables

| Table | Rows | Description |
|-------|------|-------------|
| `shorts` | ~2.1M | Daily ASIC short position data |
| `stock_prices` | ~3.7M | Historical stock prices |
| `company-metadata` | ~4.5K | Company info, industry, logos |
| `sync_status` | - | Tracks data sync runs |

### shorts Table
```sql
-- Primary short selling data from ASIC
"DATE" timestamp                    -- Report date
"PRODUCT" text                      -- Full product name
"PRODUCT_CODE" text                 -- ASX stock code (e.g., 'BHP')
"REPORTED_SHORT_POSITIONS" float    -- Number of shares shorted
"TOTAL_PRODUCT_IN_ISSUE" float      -- Total shares on issue
"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float
```

**Key Indexes:**
- `shorts_date_product_code_unique` ON (DATE, PRODUCT_CODE) - unique constraint
- `idx_shorts_product_code_date` ON (PRODUCT_CODE, DATE DESC) - time series queries
- `idx_shorts_timeseries_covering` ON (PRODUCT_CODE, DATE DESC) INCLUDE (PERCENT...) - covering index
- `idx_shorts_percent_nonzero` - partial index for non-zero percentages

### stock_prices Table
```sql
stock_code VARCHAR     -- ASX code
date DATE              -- Trading date
open, high, low, close, adjusted_close DECIMAL
volume BIGINT
```

**Key Indexes:**
- `idx_stock_prices_stock_date` ON (stock_code, date DESC)
- `stock_prices_stock_code_date_key` UNIQUE ON (stock_code, date)

### company-metadata Table
```sql
stock_code VARCHAR(50) UNIQUE  -- Primary key for joins
company_name, sector, industry, market_cap
logo_url, logo_gcs_url, logo_icon_gcs_url
website, description, summary, details
-- Enrichment fields (GPT-4 generated)
enhanced_summary, company_history, key_people
competitive_advantages, risk_factors, recent_developments
key_metrics JSONB              -- Flexible metrics storage
search_vector TSVECTOR         -- Full-text search
```

### Materialized Views (Performance)

| View | Rows | Purpose | Query Time |
|------|------|---------|------------|
| `mv_top_shorts` | ~940 | Pre-computed top shorted stocks | ~6ms |
| `mv_treemap_data` | ~6.2K | Pre-computed treemap by period/industry | ~3ms |
| `mv_watchlist_defaults` | 8 | Default watchlist stock data | <1ms |

**mv_top_shorts** - Current top shorted stocks with metadata:
```sql
SELECT product_code, product_name, current_percent, industry, company_name
FROM mv_top_shorts
ORDER BY current_percent DESC
LIMIT 50;
```

**mv_treemap_data** - Industry treemap data by period (3m, 6m, 1y, 2y, 5y, max):
```sql
SELECT industry, product_code, percentage_change, current_short_position
FROM mv_treemap_data
WHERE period_name = '3m'
ORDER BY percentage_change DESC;
```

**mv_watchlist_defaults** - Pre-computed data for default watchlist stocks (CBA, BHP, CSL, WBC, ANZ, RIO, WOW, TLS):
```sql
SELECT stock_code, latest_price, change_percent, short_percent
FROM mv_watchlist_defaults;
```

### Refreshing Materialized Views

After data sync, refresh all MVs:
```sql
SELECT refresh_all_materialized_views();
```

Or individually:
```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
REFRESH MATERIALIZED VIEW mv_top_shorts;
REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
```

The daily-sync script automatically refreshes these after loading new data.

### Performance Benchmarks

Query performance expectations (measured January 2026):

| Query | Without MV | With MV | Improvement |
|-------|-----------|---------|-------------|
| GetTopShorts (50 stocks) | ~2,300ms | ~6ms | **380x** |
| GetIndustryTreeMap | ~500ms | ~3ms | **165x** |
| Watchlist defaults (8 stocks) | ~227ms | <1ms | **227x+** |
| Time series (5 stocks, 6mo) | ~140ms | ~140ms | (still raw query) |

**Backend Implementation:**
- `getTopshorts.go` uses `mv_top_shorts` with fallback to raw query
- `getShortsTreeMap.go` uses `mv_treemap_data` with fallback to raw query
- Fallback ensures tests and dev environments work without MVs

**Production Database (Supabase):**
- Host: `aws-0-ap-southeast-2.pooler.supabase.com`
- Transaction pooler port: 6543 (use this for queries)
- Session pooler port: 5432 (limited connections)
- ~2.1M rows in shorts, ~3.7M rows in stock_prices

**Supabase Limits:**
- max_connections: 60
- shared_buffers: 224 MB
- work_mem: 2 MB
- Use transaction pooler (port 6543) to avoid connection limits

## Common Tasks

### Adding a New API Endpoint

`shorts.v1alpha1` is split into **per-domain proto files** (2026-07), each with its
own service: `market.proto` (MarketService), `stock.proto` (StockService),
`housing.proto`, `economy.proto`, `news.proto`, `screener.proto`, `search.proto`,
`reports.proto`, `enrichment.proto`, `billing.proto`, `alerts.proto`,
`industry.proto`. `shorts.proto` keeps only the legacy monolithic
`ShortedStocksService` (all 64 rpcs, message-less, for external API consumers) —
**web code must import from the domain module** (`~/gen/shorts/v1alpha1/<domain>_pb`),
never from `shorts_pb` (importing it drags the full legacy descriptor into the
route bundle; `bundle:budget` will catch it).

1. **Define the rpc + messages** in the matching domain file, e.g.
   `proto/shortedapi/shorts/v1alpha1/market.proto`, and add the SAME rpc to the
   legacy `ShortedStocksService` in `shorts.proto` (public-API back-compat).
   Annotate visibility (`option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;`)
   on BOTH copies — unannotated methods default to auth-required:

   ```protobuf
   rpc GetNewEndpoint(GetNewEndpointRequest) returns (GetNewEndpointResponse) {
     option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
   }
   ```

2. **Generate code** (commit ALL outputs, including the `sdks/java` churn —
   the committed Java SDK tracks the protos):

   ```bash
   cd proto && buf generate
   ```

3. **Implement the handler** in `services/shorts/internal/services/shorts/` —
   one `ShortsServer` struct implements every service; a new method on it
   satisfies both the domain handler and the legacy handler. New DOMAIN
   services must be mounted in `serve.go` with the shared `interceptors` +
   `withCORS`, get a rewrite rule in `web/next.config.mjs`, and internal-only
   methods need their full name in `internalOnlyMethods` (middleware_connect.go).

4. **Add store method** in `services/shorts/internal/store/shorts/store.go`

5. **Frontend types** are auto-generated in `web/src/gen/` — import from the
   domain `_pb` module and `createClient(<Domain>Service, transport)`

### Adding a New React Component

1. Create in `web/src/@/components/ui/` for generic UI components
2. Create in `web/src/@/components/` for feature-specific components
3. Follow the existing pattern:

   ```tsx
   "use client"; // Only if needed

   import { cn } from "@/lib/utils";

   interface MyComponentProps {
     // Props with JSDoc comments
   }

   export function MyComponent({ ...props }: MyComponentProps) {
     // Implementation
   }
   ```

### Database Migrations

```bash
cd services

# Create a new migration
make migrate-create NAME=add_users_table

# Apply pending migrations
make migrate-up

# Rollback last migration
make migrate-down

# Check current version
make migrate-version
```

### Running Tests

```bash
# All tests (recommended before pushing)
make test

# Frontend only
make test-frontend

# Backend only
make test-backend

# Integration tests (requires Docker)
make test-integration-local

# E2E tests (Playwright)
cd web && npm run test:e2e

# Stripe checkout smoke bench (test mode only)
npm run test:e2e:stripe:testmode
```

### Stripe Checkout Memory

- Canonical Stripe Premium price env is `STRIPE_PREMIUM_PRICE_ID`.
- Keep `STRIPE_PRO_PRICE_ID` only as a legacy compatibility fallback.
- Dedicated API Access checkout price env is `STRIPE_API_ACCESS_PRICE_ID`.
- Stripe smoke bench scope is checkout creation and redirect to `checkout.stripe.com` only.
- Do not parse checkout response bodies from Playwright network responses in this bench; cross-origin redirect timing can make bodies unavailable.

### Populating Data

```bash
# Full data population (downloads ASIC files)
make populate-data

# Quick population (uses existing CSV files)
make populate-data-quick

# Stock price backfill
cd services && make history.stock-data.backfill
```

## Key Files

| File                                    | Purpose                                   |
| --------------------------------------- | ----------------------------------------- |
| `Makefile`                              | Root-level orchestration commands          |
| `services/Makefile`                     | Backend-specific commands                  |
| `web/Makefile`                          | Frontend-specific commands                 |
| `proto/buf.yaml`                        | Protobuf configuration                     |
| `terraform/environments/dev/`           | Dev infrastructure config                  |
| `services/migrations/`                  | Database migrations                        |
| `services/chat-service/`               | AI chat backend (Gemini + tool calling)    |
| `services/news-aggregator/`            | RSS news aggregation + sentiment           |
| `web/src/@/hooks/use-chat.ts`          | Chat hook (auth, streaming, conversations) |
| `web/src/@/components/chat/`           | Chat UI components                         |
| `.github/workflows/cost-guardian.yml`  | Daily cost enforcement workflow             |

## Code Patterns

### Go Store Interface

All database access goes through store interfaces for testability:

```go
type Store interface {
    GetStock(code string) (*Stock, error)
    GetTopShorts(period string, limit, offset int32) ([]*TimeSeriesData, int, error)
}
```

### Connect-RPC Handler

```go
func (s *Service) GetStock(
    ctx context.Context,
    req *connect.Request[pb.GetStockRequest],
) (*connect.Response[pb.GetStockResponse], error) {
    stock, err := s.store.GetStock(req.Msg.ProductCode)
    if err != nil {
        return nil, connect.NewError(connect.CodeNotFound, err)
    }
    return connect.NewResponse(&pb.GetStockResponse{Stock: stock}), nil
}
```

### React Server Component Data Fetching

```tsx
// In app/stocks/[code]/page.tsx
export default async function StockPage({
  params,
}: {
  params: { code: string };
}) {
  const stock = await getStock(params.code); // Server-side fetch
  return <StockDetails stock={stock} />;
}
```

### Client-Side Data with TanStack Query

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";

export function StockPrice({ code }: { code: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["stock-price", code],
    queryFn: () => fetchStockPrice(code),
  });

  if (isLoading) return <Skeleton />;
  return <div>${data?.price}</div>;
}
```

## Environment Variables

### Required for Development

```bash
# Automatically set by make dev
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts

# For GCP features (logo storage, etc.)
GOOGLE_APPLICATION_CREDENTIALS=services/shorted-dev-aba5688f-*.json
GCP_PROJECT_ID=shorted-dev-aba5688f

# For Algolia search (optional)
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_SEARCH_KEY=0e5adba5fd8aa4b3848255a39c1287ef

# For AI enrichment (optional)
OPENAI_API_KEY=sk-...
```

### Production (Vercel + Cloud Run)

Set via Vercel dashboard and Terraform for Cloud Run services.

## Chat Service (Shorted AI)

The chat service (`services/chat-service/`) provides an AI assistant powered by Gemini LLM with access to 8 API tools (short positions, top shorts, stock details, search, news, director trades, peer comparison, weekly reports).

### Key Architecture

- **Backend**: Go Connect-RPC with server streaming (`SendMessageStream`)
- **Frontend**: Global `ChatSidebar` in root `layout.tsx` (available on all pages) + dedicated `/chat` page
- **Auth**: `X-User-Id` header via Connect transport interceptor from next-auth session
- **Conversations**: Stored in PostgreSQL (migration 000026), full CRUD via `ListConversations`, `GetConversationHistory`, `DeleteConversation`
- **Streaming**: Token-by-token via Gemini's `SendMessageStream`, tool call rounds execute synchronously between streaming segments
- **SSR Safety**: All chat components loaded via `dynamic({ ssr: false })` to prevent Connect-RPC SSR crashes

### Frontend Components

| Component | File |
|-----------|------|
| Chat sidebar (global) | `web/src/@/components/chat/chat-sidebar.tsx` |
| Message rendering | `web/src/@/components/chat/chat-message.tsx` |
| Markdown renderer | `web/src/@/components/chat/chat-markdown.tsx` |
| Conversation list | `web/src/@/components/chat/chat-conversation-list.tsx` |
| Chat hook | `web/src/@/hooks/use-chat.ts` |
| Chat page | `web/src/app/chat/` |

## News Aggregator

The news aggregator (`services/news-aggregator/`) fetches RSS feeds, matches articles to ASX stocks, and classifies sentiment.

- **Sentiment**: Primary = Gemini 2.0 Flash batch analysis (requires `GEMINI_API_KEY`), fallback = keyword heuristic
- **Storage**: `news_articles` table with parameterized queries (SQL injection fixed)
- **Retention**: 90-day TTL via `cleanup_old_news_articles()` (migration 000029)

## Screener

Stock screener with server-side filtering (`services/shorts/internal/services/shorts/screener.go`).

- **Backend**: `ScreenStocks` RPC with filters (short position range, industry, etc.)
- **Store**: `postgres_screener.go` queries materialized view `mv_screener_data` (migration 000027)
- **Frontend**: `/screener` page + `screener-widget.tsx` dashboard widget
- **Days to Cover**: Added in migration 000028

## Weekly/Monthly/Yearly Reports

LLM-generated short-selling reports at `/reports` (weekly `2026-W23`, monthly `2026-05`, yearly `2025` — one `weekly_reports` table, slug shape disambiguates).

- **Generator**: `services/weekly-report-generator/` (Cloud Run job + Fri/monthly schedulers, `terraform/modules/weekly-report-generator/`) — snapshot (movers/z-scores/streaks/industry breakdown) → two-pass multi-model synthesis (`prompts.go`) → quality gate → JSONB upsert
- **Read path**: `services/shorts/.../weekly_report.go` (`GetWeeklyReport`) + `list_reports.go` (`ListReports`); logos hydrated at READ time, never stored
- **Frontend**: `web/src/app/actions/reports/getReportData.ts` → `web/src/app/reports/`
- **CRITICAL contract**: generator struct json tags must exactly match proto snake_case field names (the API `json.Unmarshal`s JSONB straight into proto structs) — enforced by `json_contract_test.go`; any proto field addition needs a matching generator tag + `buf generate`

Operating manual (running, prompt iteration via `-print-prompt`/`-dry-run`, quality gates, landmines): use `$weekly-reports` skill (`.claude/skills/weekly-reports/SKILL.md`); service readme at `services/weekly-report-generator/README.md`.

## Housing (tracker + suburb explorer + listings crawl + price-drops)

Five products over one fact/dimension data model, one chart system and one
Connect-RPC service (`HousingService`, `housing.proto`, 11 rpcs): the
**Widow-Maker editorial feature** (`/features/the-widow-maker`, baked arrays), the
**House Prices Tracker** (`/housing`, live ABS/RBA/Valuer-General ingest), the
**suburb explorer** (`/housing` → `/housing/[state]` → `/housing/[state]/[suburb]`
choropleth drilldown, "Colour by" price / Census / electoral / gated crime), the
**residential listings crawl** (REA/Domain via warm host-Chrome CDP on residential
Macs, plus a property.com.au AVM tier), and the **price-drops board**
(`/price-drops`). **All LIVE on prod** — as at 2026-08-09: 88,689 crawl listings
across 500 suburbs, a **500-suburb** crawl catalog, **22** collector modes, 16
official-ingest jobs, 27 housing migrations (000053–000092). The
`house-price-collector` Cloud Run job **is** wired into CI + both TF environments
(PR #211) — a merge to `main` deploys it; it runs monthly (5th, 16:00 UTC).

**Docs: `docs/feature/housing/`** — start at `README.md`.

| Doc | What it answers |
|---|---|
| `docs/feature/housing/README.md` | Current state + dated prod numbers, the five rules that shape every change, surfaces, known-open items |
| `docs/feature/housing/data-sources.md` | Every source + licence, mandatory fetch posture, and what is ruled OUT (and why) |
| `docs/feature/housing/data-model.md` | Tables, MVs, migration map, and where each guard is actually enforced (DB vs code) |
| `docs/feature/housing/pipeline.md` | The 22 collector modes, the 16 official jobs, run order, timeouts, exit-code contract |
| `docs/feature/housing/operations.md` | Runbook: prod DDL, rig crawl recovery, revalidation, takedown, credentials |
| `docs/feature/housing/architecture.md` | Decision/incident record + extension recipes — read before touching crawl classification or caching |

### Landmines

- **The prod deploy does NOT run `migrate up`** — it applies a hardcoded allowlist that contains **zero housing migrations**. Apply housing DDL BY HAND (session pooler **5432**, `PGOPTIONS="-c statement_timeout=0"`) *before* merging code that reads the new columns, or every housing read path 500s. Prod `schema_migrations` lies (force-written to 75).
- **MV refresh needs that same session pooler.** Run `refresh_housing_materialized_views()` on 5432 with `statement_timeout=0`; the txn pooler (6543) kills it mid-`REFRESH … CONCURRENTLY`. Its `EXCEPTION WHEN OTHERS` guards do **not** catch the `query_canceled` a statement timeout raises, so one timed-out MV starves every MV after it (the 000095 hardening never reached housing — known-open).
- **Charts can't SSR, and functions can't cross the RSC boundary.** Every interactive chart is imported `dynamic(..., { ssr: false })` from a `"use client"` module; pass a **serializable key** (`format="aud"|"percent"|"index"`, `MetricKey` from `highlight-metrics.ts`) and look the formatter/colour scale up client-side — never pass a formatter or scale as a prop from a server page.
- **Reading `searchParams` in a server page silently forces dynamic rendering** even with `revalidate` exported, killing the ISR that serves `/price-drops` in 40–58ms. Read `?state=` client-side via `useSearchParams` under a real `<Suspense>` boundary (the `next/dynamic` fallback does not satisfy it).
- **ABS WAF**: `abs.go` MUST send `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)` + `Accept: application/vnd.sdmx.data+csv;labels=both` — a bare request 403s. Conversely, don't hand-set a UA on the crawl tier; `stealthhttp`'s native engine supplies browser-realistic TLS/headers.
- **Crawl rows are never republished raw.** REA/Domain/property.com.au rows carry `source_licence='proprietary-tos-restricted'` (a column DEFAULT, so the unlicensed state is unstorable); only derived aggregates are a publishable surface, only counts-only summaries cross to brandbrain, and `CRAWL_TRACE` artifacts stay local + gitignored. Kill switches: `HOUSING_DROP_LISTINGS_ENABLED` / `HOUSING_VALUATIONS_ENABLED` (both ON by default).
- **A hand-run crawl writes nothing.** `CRAWL_DRY_RUN` / `CRIME_DRY_RUN` / `PURGE_DRY_RUN` default to true in code; only the launchd wrappers export `false`. Check `dryRun=` in the startup log before believing a run persisted.
- **Crawl throughput and its alarm are ONE decision.** `CRAWL_DELTA_MAX_SUBURBS` (now **120**) is the ceiling of the whole crawl — 500 suburbs ÷ cap = the rotation — and `CRAWL_FRESHNESS_ALARM_HOURS` (now **120h**) must match it. The old 60/72h pairing implied an 8.3-day rotation against a 3-day alarm, so the alarm fired on the designed steady state and stopped meaning anything (measured 2026-08-18: median 117h, oldest 305h). Change one, change the other.
- **Alerting: the sentinel is the only layer that survives a dead rig.** `.github/workflows/housing-freshness.yml` (daily, read-only, files one GitHub issue) checks per-suburb `CATALOG_STALENESS` (132h) + `RIG_STATUS` alongside global `EVENT_SILENCE` — the global check alone stayed **green through a two-day outage**. Rig-side, every terminal wrapper failure pushes via `hc_alert` (notification + `CRAWL_ALERT_WEBHOOK`, falling back to `CRAWL_FRESHNESS_WEBHOOK`); unset webhook = notification only.
- **The rig is a hand deploy and has drifted before** (binary 4h17m behind the fix it was assumed to carry). Use `deploy/stage-rig.sh` (`--check` is read-only — run it FIRST in any crawl incident); wrappers log `vcs.revision` at run start. The Playwright driver now lives at `CRAWL_PW_DRIVER_DIR` (`~/.shorted-housing-crawl/pw-driver`), **not** `~/Library/Caches` where a sweep deleted it; repair with `-mode install-driver`.

## Economy (map explorer + state pages + series platform)

`/economy` (map-first hub, ISR) → `/economy/[state]` (SSG ×8, banner heroes with
centered state silhouettes, breadcrumbs) over a **generic economic-series
layer**: `economic_series` + `economic_observations` (migrations
000081/000082/000083/000085) fed by `services/economy-collector`
(**11 sources**: rba, cpi, labour, trade, gdp=SFD, petroleum, govfin+detail,
approvals, retail, population, markets-derived) on a monthly Cloud Run Job,
read by the public **`EconomyService`** (economy.proto after the proto split):
`ListEconomicSeries`/`GetEconomicSeries` + `ListStateCompanies`/
`GetStateCompanyAggregates` (operations-weighted company↔state exposure).
472 series / ~120k observations. **LIVE on prod.**

### Key files

| File | Purpose |
|------|---------|
| `services/economy-collector/` | All importers (`-mode all`); probe-pinned constants; fail-closed filters |
| `services/pkg/absdata/` | Shared ABS SDMX-CSV + RBA CSV clients (WAF-safe UA is mandatory) |
| `services/migrations/000081…000085` | Series layer, registry kind/method extensions, state_exposure + MV |
| `services/shorts/.../economy.go`, `state_exposure.go` | RPC handlers (normalized cache keys) |
| `services/enrichment-processor --backfill-state-exposure` | LLM operations-weighted state footprints (top 300 = 93.8% mkt cap) |
| `web/src/@/lib/economy/map-metrics.ts` | Serializable "Colour by" registry (kind:"series" \| "aggregate") — availability + metrics single source of truth |
| `web/src/@/components/economy/` | Map explorer, state charts/companies/correlations, dual-axis chart, `<EconomyIcon>` sprite |
| `web/src/app/economy/` + `[state]/` | Hub + state pages; actions in `app/actions/getEconomy.ts` (KV last-good layer) |
| `web/scripts/economy-icons/` | Icon-set generation pipeline (housing-icons clone) |
| `terraform/modules/economy-collector/` | Cloud Run Job + monthly scheduler (5th, 17:00 UTC) |

### Landmines (details: `docs/economy-architecture.md`)

- **ISR + connect POST**: the `next:{revalidate}` tag on server-action connect
  transports is LOAD-BEARING (untagged → no-store → "static to dynamic" throw
  during regen → placeholder baked for an hour). The Upstash KV last-good layer
  in `getEconomy.ts` is the durable protection — mirror it for new ISR surfaces.
- **After every deploy**: promote resets all ISR pages to placeholders — run the
  revalidate sweep (secret via GCP SM `REVALIDATION_SECRET`, browser UA required).
- **ABS reality vs assumptions**: no GSP or GFS SDMX flows exist (SFD proxy +
  GFS XLSX importer instead); CPI v2 has no UNIT_MULT and needs FREQ filtering;
  labour has no NT/ACT seasadj; trade LNG is confidentialised out of state splits.
  Never derive series keys from source labels — stable codes/static maps only.
- **Prod company-metadata lacks `sector`/`description`** (local has them) —
  query only columns present in both.
- **Prod MV refresh**: session pooler 5432 + `statement_timeout=0` (txn pooler
  kills `refresh_all_materialized_views`).
- First collector run in a new env is manual: `gcloud run jobs execute economy-collector`.

Full architecture + extension recipes (new SDMX/XLSX source, new map metric,
new derived series): `docs/economy-architecture.md`.

## Politicians — register of interests ("Parliament's Portfolio")

What federal MPs and senators declare, from the APH Registers of Members'/
Senators' Interests. **LIVE on prod**: ~17.1k published rows, 319 politicians,
296 listed companies, 335 suburbs, 241 portraits, parliaments 44–48.

**Docs: `docs/feature/politicians/`** — start at `README.md`. `data-sources.md`
(licences + what is ruled out), `data-model.md` (schema + guards), `pipeline.md`
(job modes), `operations.md` (runbook). `architecture.md` is the 135KB
decision/incident record — read §8.x before touching resolution logic. The
editorial gate is `docs/influence-editorial-standards.md` (whole influence layer,
not just this feature).

Surfaces: `/politicians` (hub: Algolia search + party×industry heatmap, static
ISR), `/politicians/[slug]`, `/changes`, `/short-interest`, plus cards on
`/shorts/[code]`, `/housing/[state]/[suburb]`, `/economy/[state]`. Operator
consoles at `/admin/register/securities` and `/admin/register/politicians[/slug]`.

Jobs: `shorted influence -mode register-{discover,fetch,load,resolve,freshness,
propose-aliases,promote-aliases,handbook,photos,index}` — all default
`REGISTER_DRY_RUN=true` and are **excluded from `-mode all`** (an 804-PDF crawl
must never fire from a deploy). `make register-photos` / `register-index`.

### The rules that shape every change here

- **What is held, never how much.** No amount/quantity/value column exists
  anywhere in the subsystem; a migration test asserts none appears. Rule 5.
- **Extracted facts are publishable, source artefacts are not.** We deep-link
  aph.gov.au; the GCS bucket is a private cache with no CDN. This is why
  portraits come from Wikimedia Commons and **never** from aph.gov.au — and why
  **LinkedIn is permanently out** (its UA bans displaying data obtained via third
  parties, and the clean-licence proxy covers 2.8%).
- **Withhold rather than guess.** Ambiguity always resolves to publishing
  nothing. A name search once matched "Anthony Smith" to Dean Smith.
- **APH is CC BY-NC-**ND**.** NC matters on a paid product; ND means never
  rewrite an APH prose string — store facts as verbatim atoms.
- Attribution on a portrait is a **licence obligation** enforced in four places
  (DB CHECK, store, proto, component), not a caption.

### Landmines

- **The prod deploy does NOT run `migrate up`** — it applies a hardcoded
  allowlist. Apply new migrations BY HAND (session pooler 5432,
  `statement_timeout=0`) BEFORE merging, or the API ships selecting columns prod
  lacks and every politician read path 500s.
- `run-tests` is `if: github.event_name != 'pull_request'` — Go tests gate the
  DEPLOY, not the PR. **golangci-lint runs in no CI job at all.**
- An **empty KV entry used to be served as a hit**, pinning zeros for 24h;
  `readCached` now takes a non-emptiness predicate. Unblock with
  `?flush=politicians`.
- `compliance.tsx` has no `"use client"` and imports generated protobuf —
  importing it from a client component kills the static build with a minified
  "Element type is invalid". Use `@/lib/politics/party-palette`.
- Slugs are minted once and never reassigned; a merge retires a row via
  `merged_into_id` rather than deleting it.

## Twitter / X Automation

`@shorted___` is the live X handle. The bot is a self-contained Node + TypeScript project at `scripts/twitter/` that pulls live ASIC short data, market news, and director trades from the public shorted.com.au API and posts curated tweets.

### Auth (OAuth 2.0 PKCE)

Credentials live in repo-root `.env`:

| Var | Source |
|---|---|
| `TWITTER_CLIENT_ID` | X Developer Portal → Keys and tokens → OAuth 2.0 |
| `TWITTER_CLIENT_SECRET` | same |
| `TWITTER_REFRESH_TOKEN` | minted by running `bootstrap-oauth2` once |

The refresh token is **rotated by X on every use** — the script writes the new token back to `.env` on each post. Don't manually edit it.

Re-bootstrap any time the token is invalidated:
```bash
cd scripts/twitter
npx tsx src/index.ts bootstrap-oauth2
```

The X app must have `http://127.0.0.1:8787/callback` in its callback URIs and the Read+Write permission scope. Required X scopes: `tweet.read tweet.write users.read offline.access`.

OAuth 1.0a is also supported (`TWITTER_API_KEY` / `_SECRET` + `TWITTER_ACCESS_TOKEN` / `_SECRET`) as a fallback — accepts legacy `CONSUMER_KEY`/`SECRET_KEY` naming too.

### Commands

```bash
cd scripts/twitter
# Preview (dry-run, default):
npx tsx src/index.ts daily-shorts
npx tsx src/index.ts movers
npx tsx src/index.ts stock-of-the-day
npx tsx src/index.ts weekly-digest
npx tsx src/index.ts breaking-news
npx tsx src/index.ts insider-trade --stock=BHP

# Post for real:
npx tsx src/index.ts daily-shorts --live
```

`TWITTER_DRY_RUN_DEFAULT=true` is the safety net — dry-run is on unless `--live` is passed.

### Scheduling

**Local cron** is the production path (see `scripts/twitter/OPERATIONS.md` §2.1 for the full crontab block). Cadence: daily-shorts 11:00 AEST, movers 16:30, stock-of-the-day 09:00, weekly-digest Fri 17:00, breaking-news every 2h during ASX hours.

GitHub Actions workflow at `.github/workflows/twitter-bot.yml` exists but is **manual-only** (`workflow_dispatch`) — the `schedule:` block is commented out. To move to CI scheduling, see `OPERATIONS.md` §2.2 (needs a fine-grained PAT to re-store the rotated refresh token after each run).

### Key files

| File | Purpose |
|---|---|
| `scripts/twitter/src/index.ts` | CLI entry, dispatches commands |
| `scripts/twitter/src/templates.ts` | Tweet text generators (data → string) |
| `scripts/twitter/src/twitter-client.ts` | X API wrapper, OAuth 2.0 + 1.0a + DryRun stub |
| `scripts/twitter/src/shorted-api.ts` | Public shorted.com.au API client |
| `scripts/twitter/src/oauth2-bootstrap.ts` | One-time refresh-token mint flow |
| `scripts/twitter/PROFILE.md` | Brand setup (handle, bio, header, colours, strategy) |
| `scripts/twitter/OPERATIONS.md` | Full ops runbook |

### Gotchas

- **Cloudflare API rate limit**: rapid bursts to `api.shorted.com.au` trigger the Cloudflare edge `http_ratelimit` rule before origin. For trusted E2E/load tests, use the Terraform-managed bypass: set `TF_VAR_rate_limit_testing_bypass_secret`, apply `terraform/environments/prod`, then send both `User-Agent: Shorted-E2E/1.0` and `X-Shorted-Testing-Bypass: <secret>`. Never make this UA-only; the rule must require both UA and secret header.
- **Refresh token rotation**: every X API call mints a new token. Local cron handles this automatically (writes to `.env`). CI needs a PAT-based persistence step (documented in OPERATIONS.md §2.2).
- **Edge worker hot-cache bug** (fixed in PR #139): if the bot returns the same stock's data for every productCode, the Cloudflare worker's hot cache key may have regressed — verify `buildHotCacheKey` in `services/edge-worker/worker.js` is hashing the POST body.

## Known Issues & Gotchas

### SSR Issues with @connectrpc/connect Imports (CRITICAL)

**Problem**: Direct imports from `@connectrpc/connect` cause SSR failures in Next.js, resulting in 500 errors on all routes with the error:
```
Error: Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: undefined.
```

**Root Cause**: The `@connectrpc/connect` package (and `@bufbuild/protobuf`) uses ES modules with initialization code that fails during Next.js server-side rendering. Even `"use client"` components can trigger this if they're transitively imported by server components.

**Import Chain Example**:
```
layout.tsx (server) → ThemeProvider → QueryClientProvider → getQueryClient() → retry.ts → @connectrpc/connect ❌
```

**Solution**: Use duck-typing instead of direct imports for Connect-RPC types:

```typescript
// ❌ BAD - causes SSR failures
import { ConnectError, Code } from "@connectrpc/connect";

function isRateLimitError(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.ResourceExhausted;
}

// ✅ GOOD - duck-type check without imports
interface ConnectErrorLike {
  code: number;
  message: string;
  metadata: { get: (key: string) => string | null };
}

function isConnectErrorSync(error: unknown): error is ConnectErrorLike {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "number" &&
    "message" in error &&
    "metadata" in error
  );
}

// Use hardcoded error codes (gRPC/Connect standard)
const CODE_RESOURCE_EXHAUSTED = 8;

function isRateLimitError(error: unknown): boolean {
  return isConnectErrorSync(error) && error.code === CODE_RESOURCE_EXHAUSTED;
}
```

**Key Files**:
- `web/src/@/lib/retry.ts` - Retry utility using duck-typing (fixed Feb 2026)
- `web/src/@/lib/query-client.ts` - Query client configuration (imports retry.ts)

**Prevention**:
1. Never import from `@connectrpc/connect` in files that may be imported during SSR
2. Keep Connect-RPC imports isolated to client-only API call files
3. Use duck-typing for error handling utilities that need to work in both environments

### Firebase Admin SDK — Lazy Initialization (CRITICAL)

**Problem**: `firebase-admin.ts` initializing eagerly at module scope crashes during `next build` when CI provides a dummy private key.

```
FirebaseAppError: Failed to parse private key: Error: Too few bytes to parse DER.
Error: Failed to collect page data for /api/auth/[...nextauth]
```

**Solution**: Use Proxy-based lazy getters that defer initialization to first access:

```typescript
function getApp(): App {
  if (getApps().length) return getApps()[0]!;
  return initializeApp({ credential: cert({...}) });
}

export const adminAuth = new Proxy({} as ReturnType<typeof getAuth>, {
  get(_, prop) {
    const auth = getAuth(getApp());
    return (auth as unknown as Record<string | symbol, unknown>)[prop];
  },
});
```

**Key**: Cast through `unknown` first — `as unknown as Record<...>` — or TypeScript rejects the Proxy cast.

### CORS — Use Next.js Rewrites Instead of Backend CORS Headers

Client-side API requests should proxy through Next.js `rewrites()` to avoid CORS issues with Cloud Run:

```javascript
// next.config.mjs
async rewrites() {
  return [{
    source: "/shorts.v1alpha1.ShortedStocksService/:path*",
    destination: `${shortsApiUrl}/shorts.v1alpha1.ShortedStocksService/:path*`,
  }];
}
```

- Client-side: use relative URLs (`""` as baseUrl)
- Server-side: use full backend URL
- This eliminates the need for CORS headers entirely

### Vercel Environment Variables — Escaped Newlines

Vercel project-level env vars can have literal escaped newline suffixes (`\n`) baked into JS bundles. `.trim()` is not enough for client-side Firebase config; use `normalizeFirebasePublicConfigValue` in `firebase-public-config.ts`. Production releases must run `npm --prefix web run firebase:preflight` before build and the Firebase Google sign-in bootstrap check in release smoke. The failure signature is `API_KEY_INVALID` from `identitytoolkit.googleapis.com` before `/api/auth` is reached. See `docs/FIREBASE_AUTH_VALIDATION.md`.

### Cloud Run — Always Add Health Probes in Terraform

ALL Cloud Run services need `startup_probe` and `liveness_probe` in Terraform:

```hcl
startup_probe {
  http_get { path = "/health" port = 8080 }
  initial_delay_seconds = 15
  period_seconds        = 10
  timeout_seconds       = 5
  failure_threshold     = 3
}
liveness_probe {
  http_get { path = "/health" port = 8080 }
  initial_delay_seconds = 30
  period_seconds        = 30
  timeout_seconds       = 10
  failure_threshold     = 3
}
```

Missing probes → "Error code 9: container failed startup probe checks".

### Jest Testing — Firebase and ESM Dependencies

- `firebase-admin/app` and `firebase-admin/auth` need explicit mocks in `setup.ts` (not just `firebase-admin`)
- `jwks-rsa` bundles `jose` in nested `node_modules/` — add both to `transformIgnorePatterns`
- `withRetryAndNotFound` returns `undefined` for ALL errors — tests should expect `toBeUndefined()`, not `rejects.toThrow()`
- When changing component API calls (e.g., `searchStocksClient` → `fetch()`), always update corresponding tests
- Use `getAllBy*` when multiple matching elements exist; use `toContain` for partial CSS class matching

### Pre-commit Hook — golangci-lint OOM and Build Failures

- `golangci-lint` needs `--concurrency 1 --timeout 120s` to avoid OOM (configured in `Makefile` `lint-backend` target)
- `make build-frontend` may fail locally if Next.js pages try to prerender against `api.shorted.com.au` (TLS cert mismatch in local env) — this is a pre-existing environment issue, not a code issue
- The hook starts DB + backend automatically, but the API URL in Next.js config may still point to production

### GitHub Actions — Workload Identity Federation

- `google-github-actions/auth@v2` requires `permissions: id-token: write` at the workflow level
- Without this, all jobs fail with: "GitHub Actions did not inject $ACTIONS_ID_TOKEN_REQUEST_TOKEN"
- This applies to Cost Guardian, terraform-deploy, and any workflow using GCP WIF auth

### Vercel Deployment — Root Directory

The Vercel project Root Directory is set to `web/`. When deploying via CLI, deploy from the **repo root**, not from `web/`, or Vercel looks for `web/web/`.

### Git Worktree

`main` branch may be checked out in a separate worktree. Can't `git checkout main` — use `git branch fix-name origin/main` instead.

## Debugging

### Backend not starting?

```bash
make clean-ports      # Kill stale processes
make dev-stop         # Stop all services
make dev              # Restart
```

### Database connection issues?

```bash
make dev-db           # Ensure DB is running
docker ps             # Check container status
```

### Frontend build errors?

```bash
make clean-cache      # Clear Next.js cache
cd web && rm -rf node_modules && npm install
```

### Production 500 errors after deployment?

Use the project troubleshooting skill first:

```text
Use $shorted-prod-troubleshooting
```

This skill is installed at `/Users/benebsworth/.codex/skills/shorted-prod-troubleshooting/SKILL.md` and contains the current checklist for release smoke, Vercel logs, Cloudflare Worker/wrangler diagnostics, API edge checks, RUM/metrics, database/data freshness, and closeout evidence. Use it before adding fallbacks or making release/promote decisions.

If the site returns 500 on all routes after a deployment:

1. **Check Vercel function logs**:
   ```bash
   vercel logs --follow
   ```

2. **Look for "Element type is invalid" errors** - this indicates an SSR import issue (see "SSR Issues with @connectrpc/connect" above)

3. **Rollback to working deployment**:
   ```bash
   # List recent deployments
   npx vercel ls

   # Promote a working deployment to production
   vercel promote <deployment-url> --yes
   ```

4. **Binary search to find the problematic component**:
   - Comment out providers/components in `layout.tsx`
   - Deploy to preview URL
   - Test until you find the breaking component
   - Check its import chain for `@connectrpc/connect` or `@bufbuild/protobuf`

### Integration tests failing?

```bash
# Ensure Docker is running
docker info

# Run with verbose output
cd services && go test -v ./test/integration/...
```

## Infrastructure

- **GCP Project**: `shorted-dev-aba5688f`
- **Region**: `australia-southeast2`
- **Artifact Registry**: `australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted`
- **Database**: Supabase (production), Docker PostgreSQL (development)

### Terraform

```bash
cd terraform/environments/dev
terraform init
terraform plan
terraform apply
```

### Cross-repo: this repo's Cloudflare creds feed cuttlefish's shared-droplet IaC

The repo-root `.env` Cloudflare creds (`TF_VAR_cloudflare_email` + `TF_VAR_cloudflare_global_api_key`)
are **also used by cuttlefish's shared-droplet Terraform** to manage the `telesis.dev` DNS records
(`api`/`origin.telesis.dev`). It needs the **global key** because shorted's zone-scoped Cloudflare
token (`TF_VAR_cloudflare_api_token`, shorted.com.au) gets an *auth error* on the `telesis.dev` zone.
**Don't rotate/remove the global key + email without updating cuttlefish's stack** (or its `terraform
plan` for that box will fail). Full story: `~/projects/cuttlefish/DROPLET.md`. (Follow-up there: mint a
telesis.dev-scoped token so this cross-dependency on shorted's account-wide key can be dropped.)

## External Services

| Service   | Purpose               | Config Location                    |
| --------- | --------------------- | ---------------------------------- |
| Supabase  | Production PostgreSQL | `web/.env.local`                   |
| Algolia   | Search index          | `services/Makefile`                |
| Firebase  | Authentication        | `web/src/@/lib/firebase-client.ts` |
| GCS       | Logo storage          | Terraform                          |
| Cloud Run | Backend hosting       | Terraform                          |
| Vercel    | Frontend hosting      | `web/vercel.json`                  |
| Upstash   | Rate limiting (Redis) | Environment variables              |

## Rate Limiting

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

**Two surfaces.** The one worker script is routed on **both**
`api.shorted.com.au/*` (Terraform) and `shorted.com.au/*` (route managed outside
Terraform), and the client IP it sees differs on each. On the browser route
`cf-connecting-ip` is the **real end user**. On the API route, traffic arriving
via the Next.js rewrites in `web/next.config.mjs` comes from **shared Vercel
egress IPs** — an anon-IP bucket there would 429 real users en masse, which is
why the first cut shipped with enforcement off.

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
`X-RateLimit-Tier`, `X-RateLimit-Upgrade-Url`, `Retry-After`, plus the
per-minute/monthly headers above) so a plain `curl` or a non-Connect client
needs no parser.

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

CI passes it as `TF_VAR_rate_limit_ssr_bypass_secret` from the GitHub Actions
secret `CLOUDFLARE_SSR_BYPASS_SECRET` (terraform-deploy.yml plan + apply).

Web side: `web/src/app/actions/config.ts` attaches
`X-Shorted-Ssr-Bypass: $SHORTED_SSR_BYPASS_SECRET` in
`serverFetchWithUserAgent` **only** when that server-only env var is non-empty
**and** the request targets a shorted API origin (`api.shorted.com.au` or the
configured `SHORTS_SERVICE_ENDPOINT`/`SHORTS_API_URL`/`SHORTED_EDGE_API_URL`
host). It is **never** `NEXT_PUBLIC_*` and must never reach a client bundle or
a third-party host.

Mint + rotate (all three must be updated together — Cloudflare rule, CI, Vercel):
```bash
SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
gh secret set CLOUDFLARE_SSR_BYPASS_SECRET --repo <owner>/shorted --body "$SECRET"
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

## Git Workflow

```bash
# Before pushing
make test             # Runs full validation

# Or use the hook
make install-hooks    # Sets up pre-push hook
```

## Versioning

The project uses git-based versioning. The version is automatically bumped on each frontend build via `web/scripts/bump-version.sh`, which generates versions like `v0.2.2-748-g032f59db`.

**Always commit changes** to keep the version info current. The version is displayed in the app and used for debugging deployed builds.
