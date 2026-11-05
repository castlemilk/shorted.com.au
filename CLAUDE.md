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
| MCP server       | 9091 | `services/shorts/internal/mcp/`  | `/mcp` — 32 read-only tools, plus the signed-in user's six alert tools behind `alerts:write`; OAuth 2.1 (same process as the Shorts API) |
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
- `idx_shorts_timeseries_full` ON (PRODUCT_CODE, DATE DESC) INCLUDE (PERCENT, REPORTED_SHORT_POSITIONS, TOTAL_PRODUCT_IN_ISSUE) - covering index for the chart and sparkline reads (000141, hand-applied); it replaces `idx_shorts_product_code_date` and `idx_shorts_timeseries_covering`, which 000142/000143 drop once the chart's plan uses it (the sparklines and GetStock keep the smaller old indexes until they are gone)
- `idx_shorts_percent_nonzero` - partial index for non-zero percentages

### stock_prices Table
```sql
stock_code VARCHAR     -- ASX code
date DATE              -- Trading date
open, high, low, close, adjusted_close NUMERIC(12,4)  -- DECIMAL(10,2) before 000131 (applied by the deploy)
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

### Benchmark index series (`index_prices`)

XJO, XAO, XKO and XJT daily levels, kept out of `stock_prices` on purpose (an
index is not a security). Fetched by `shorted market-data index-sync` (CronJob
`shorted-index-sync`, daily, `-years 2`). Each bar is dated by its ASX session
(Sydney date), not its UTC day, so daylight-saving sessions are not filed one day
early. Stored rows inside the fetched window that the response does not stamp
are removed per series, in the same transaction as the upsert; a clean-up that
would remove more than 15% of the window's rows is refused, and the run then
exits non-zero once the other series are written. The scheduled run
re-dates only its two-year window; the one-off full re-fetch (`-years 21`) ran on 2026-11-05, so the
whole stored history is dated by ASX session (14 leftover rows on dates Yahoo has no close for, each a
shifted copy of the next session, were removed by hand the same day). The operator
steps, the backup and the post-check are in `services/jobs/README.md`
("Benchmark indices").

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

**Supabase Data API: closed by `000138_harden_data_api_grants`; keep it closed.**
PostgREST serves whatever `anon` and `authenticated` can reach in `public` to
anyone with the (non-secret) anon key, and nothing here uses it.
- Never `GRANT` anything to `anon`, `authenticated` or `PUBLIC`, make one of them
  an owner, create a policy, or FORCE/DISABLE row level security, in ANY `.sql`
  file (migrations, the legacy `supabase/` and `web/supabase/` SQL that
  `supabase db push` would apply, `analysis/`, `scripts/`):
  `services/migrations/data_api_grants.test.mjs` fails. A GRANT with a computed
  grantee is allowed only in the reviewed carries in 000131 and 000132. A
  `SECURITY DEFINER` function pins `search_path` and revokes `PUBLIC`'s EXECUTE
  in the same file. The same test pins 000138's catalog queries and the check's
  classes whole: change one only with a re-verification, pin included.
- Closed = zero rows from `task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql`.
  Apply 000138 by hand (pre-check, `task db:prod:apply`, check, until zero rows)
  BEFORE its merge, and open its PR only after (the repo is public). The merge
  deploys (see "A merge is not a deploy until its deploy has run"): on a
  still-open database the replay stops with `object_in_use` if a refresh is in
  flight, failing `terraform-apply` before any image is swapped, but
  `deploy-vercel-prod` still promotes the web app. On a closed database it does
  nothing. Runbook: `docs/operations/supabase-data-api.md`.
- 000138 stays the LAST file the deploy replays, so each deploy re-closes what
  the others open (re-running it by hand is the immediate fix): a new
  allowlisted migration goes ABOVE it in `terraform-deploy.yml`.

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
| `terraform/environments/prod/`          | Production infrastructure config           |
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

# Cloud features are fail-closed locally. Set an explicit project/bucket and
# use ADC only when the task genuinely needs GCP access.
GCP_PROJECT_ID=
GCS_LOGO_BUCKET=

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

## Stock picker (`/strategies`, strategy-driven shortlists)

The route lives in `web/src/app/strategies/` (moved from `app/picks` by the URL move in `docs/feature/strategies/brief.md`). Every
`/picks` URL answers 308 to `/strategies` through `web/src/config/strategy-redirects.mjs`.
`components/picks/` and `public/picks-art/` keep their names: they are not routes.

`/strategies` hub + `/strategies/[strategy]` (ISR 3600, static params from
`web/src/@/lib/strategies/registry.ts`) over `StrategyService`
(`strategies.proto`: `ListStrategies`, `GetStrategyPicks` with `sort_by` /
`require_fundamentals`, `GetStockStrategyFit`) and
`StockService.GetStockFundamentals` (periods, `growth`, `quality`, `coverage`,
`latest_filing`). Five strategies ship: `zanger-breakout`, `canslim`,
`minervini-trend-template`, `crowded-short-breakout`, `quality-compounders`.
Every rule evaluates to **pass / fail / unknown**; unknown (missing data, or a
ratio not meaningful for the company) never counts as a pass and blocks status
`triggered`. Contracts: `docs/plans/stock-picker.md` (picker, strategies) and
`docs/plans/fundamentals-coverage.md` (full statements, filings, quality,
valuation, stock page).

| Piece | Where |
|---|---|
| Strategy prose, rules, weights, evaluator, sort, valuation, financials rule (no DB) | `services/pkg/strategy/engine/` (prose lives HERE once; the evaluator moved from `services/shorts/internal/strategies/` in 2026-11; `services/pkg/strategy/instrument/` holds ClassifySecurity; `engine/version.go` is the engine version; the web registry holds SEO metadata only) |
| Rules spec: the versioned rule set as data, canonical JSON, `rules_hash`, the v0 registry (`Registered`: Changes, KnownIssues, Recipe, nil on v0), rule prose templates, the execution recipes (the five r1 recipes, their validation, canonical hash and printed lines) | `services/pkg/strategy/spec/` (`spec.go` types, `canonical.go` and `RulesHash`, `registry.go`, `v0.go`, `prose.go`, `recipe.go` (`Recipe`, `Validate`, `RecipeHash`, `R1Recipes`, `RenderRecipeLines`, `RecipePreface`); pinned goldens in `spec/testdata/spec_hashes.golden`, `recipe_hashes.golden` and `recipe_lines.golden`). The rule prose templates in `prose.go` are not served yet: served evaluation and author prose still come from the engine until a later version generates them from the templates. Engine output golden: `engine/testdata/evaluate.golden`, with `engine/testdata/version_history.golden` |
| `quality-compounders` (house, no regime gate) | core `roe` (>= 15%), `net_margin` (>= 10%), `cash_conversion` (FCF > 0 and >= 0.8x NPAT), `leverage` (net cash, or net debt / EBITDA <= 2.5), `liquidity`; trigger `above_sma200`; non-core `revenue_not_shrinking` |
| `sort_by` | `score` (default, rank order), `revenue_yoy`, `eps_yoy`, `roe`, `net_margin`, `fcf_margin`, `pe` (ascending), `market_cap`; unknowns last, growth outside [-95%, +500%] after every measured figure; `rank` stays the evaluator's; any other value is `InvalidArgument` |
| Score (`weights.go`, `proximity.go`) | A pass earns weight x (0.6 + 0.4 x strength) x 100; a FAILING trigger rule (`Strategy.TriggerRules`: breakout, near_high / off_high, rs_leader, above_sma200) earns weight x 0.3 x proximity x 100, proximity 1 at the trigger line and 0 at the rule's far distance (10% under the pivot, 15 / 25 points under the 52-week lines, 20 RS points under the quartile cut-off, 10% under the 200-day), so setups rank nearest-to-firing first (2026-10-21). 0.3 < 0.6 keeps a near miss below a floor pass; a triggered score is untouched. Every trigger rule's evaluation prose ends with `evalTriggerCredit` (`TestTriggerRuleProseStatesTheCredit`) |
| Art (scenes) | `lib/strategies/scenes.ts`: one generative scene per strategy, the glyph's mechanism at scene scale (the weir, the staircase, the fan, the coil, the meter), as a pure `sceneFrame(slug, w, h, t)` of SVG paths in the theme's tones (ink, amber, olive, rust, muted; never market red or green). Drawn three ways from the one geometry: the SSR'd inline-SVG still in the ISR HTML (`components/picks/strategy-scene.tsx`, `SCENE_STILL_TIME` picks the strategy's moment), a Canvas 2D animation layered over it in the browser (`strategy-scene-canvas.tsx` via the lazy client module: a few KB, no three.js; 30 fps cap, paused off-screen and on a hidden tab, nothing under reduced motion, theme colours re-read from the CSS variables; `data-scene-live` on the host fades the still out), and the strategy OG card (`OgCard.scene`). The scenes answer the pointer (`ScenePointer`, eased per frame, read on the nearest `data-scene-stage` ancestor: the strategy header section and the hub row's article, so a pointer over the H1 plays the scene behind it; touch is a tap, nothing is prevented): past the base the hand pulls Zanger's plume over the pivot, the CAN SLIM marker walks to it, price lifts under it on the fan and the fan opens for a high hand, the coil compresses under a pressing hand and releases when it leaves, the needle swings to it on the dial. The still and the OG card never see a pointer. The two scene files are the ONLY `use client` modules in the kit (`client-boundary.test.ts`). The scenes are the one place the desk loops; they are decorative, aria-hidden and behind a scrim |
| Art (brandbrain) | `web/scripts/picks-art/`: one warm-duotone scene per strategy (the glyph's mechanism at scene scale) through the brandbrain flow-orchestrator MCP (`web/scripts/lib/brandbrain-flow.mjs`, the ONE shared driver) or the OpenAI fallback; `bake.mjs` writes `public/picks-art/<id>.{light,dark}.avif`, `og/<id>.jpg` and the manifest `lib/strategies/art.generated.ts` (slug -> content hash; empty until baked). `strategyArt(slug)` is null without an entry and the generative scene is shown instead (`hasStrategyArt`): the strategy header is a bordered band on the art (`StrategyArtBand`), the hub row has a 3:2 plate column (`StrategyArtPlate`), the strategy OG card takes the JPEG as `backgroundSrc` (over the scene). Run it locally (the MCP and its login live on the owner's machine), commit the baked files with the manifest |
| Store | `store/shorts/postgres_strategies.go`, `postgres_fundamentals.go` (the growth and extras reads are `pgsource`'s, which the store delegates to with the 42P01/42703 tolerance unchanged): a missing view = empty universe; a schema without 000132 (42P01 / 42703) = nil quality, provenance and coverage, never a 500 |
| Data: `stock_fundamentals` (+ `_sync`), `mv_fundamentals_growth` | `000129`, widened by `000132` (below); `000155` adds the vintage trigger (landmine below) |
| Data: `stock_fundamentals_vintages` | `000155`: one row per insert (`I`), changed update (`U`), delete (`D`), plus a one-time baseline (`B`), written by trigger `trg_fundamentals_vintage`. Kept forever, never pruned |
| Data: `asic_report_ingests`, `shorts_revisions` | `000155`: written by `shortdatasync` (daily, poll, reconcile), never by a trigger, so `shorts` (2.1M rows) gains none. `loaded_rows >= file_rows` is the report-completeness rule; a zero-code file records `file_rows` NULL |
| Data: `mv_price_features`, `mv_market_regime`, `refresh_strategy_views()` | `000130`; refreshed by `shorted picks -mode refresh` weekdays 13:30 UTC, AFTER the price sweep (not inside `refresh_all_materialized_views()` at 10:00, which runs before prices land). Order: regime, growth, quality, price features. The step pins `client_min_messages = notice` and fails on a `Skipping <view>` warning or on a picker view with no `Refreshing <view>` NOTICE (a stale 000130 body: re-apply 000132) |
| Data: `000132_extend_fundamentals` | 21 statement lines on `stock_fundamentals` (gross profit to current liabilities; outflows negative); `field_sources` JSONB (only fields NOT from the row's `source`: Markit, a filing, `derived:*`); `source_document_url` / `_date`; `period_type='quarter'` = a balance snapshot (no flow fields); sync `last_outcome`, `consecutive_empty`, `median_k`, `fx_converted`, `native_currency`; `picks_run_lease`; `financial_report_extractions.document_meta`; growth view rebuilt once with `revenue_basis_source` / `eps_basis_source` (`vendor` / `filing`) and `revenue_latest_period_end` / `revenue_prior_period_end` appended; new `mv_fundamentals_quality` (one flow row + one same-currency balance row at or up to 6 months before it) |
| Job | `shorted picks` (`services/jobs/README.md` "picks"): `-mode all` daily 15:00 UTC (fundamentals, filings, refresh; 12600s timeout, 1 retry). Fundamentals is budget-driven, no count cap: `PICKS_FUNDAMENTALS_BUDGET_MIN` 170 at 4s/code, priority due filers, never attempted by market cap, failures, stale successes (14-day skip, 45 for repeat empties); pre-000132 sync rows (`last_outcome` NULL) queue with never attempted and are never skipped, so the first nights after the deploy re-fetch the universe largest first (`pre_000132=N` in the log); breakers at 25 consecutive failures, >30% of the last 100 Yahoo requests, Markit off after 10; 20-minute budget on a task retry. One writer via `picks_run_lease` (a held lease exits 0). After a refresh: waits 16 min, then revalidates tags `strategy-picks` (+ `fundamentals` when rows changed) |
| Parity shadow | `shorted strategies -mode parity` (read-only) and, after each live weekday `-mode refresh`, a log-only comparison when `STRATEGY_PARITY_SHADOW=on` (Cloud Run picks job and both CronJob twins). Holds fs1 to `mv_price_features`, the regime to `mv_market_regime` and sf0 days-to-cover to 000080's `latest_shorts`/`avg_volume` CTEs, inside one REPEATABLE READ transaction. Log line `strategy_parity ... conclusive=<bool>`; inconclusive unless the newest price sweep completed before the refresh began. Never changes the picks exit code; never runs in `-mode all`. Code: `services/jobs/internal/jobs/strategies/`; README "Parity shadow" |
| Filings | `financial-report-extractor` (Python, `services/report-extractor`, `module "report_extractor"`): daily 14:00 UTC, `--recent 2 --limit 360 --workers 4 --max-pages 8 --budget-min 90` (360 since 2026-10-11; 917 companies had an unread results document), 7200s, no retries. **Backend `openrouter`** (`direct_extract.py`, since 2026-09-29): one call per document, DeepSeek v4 Flash primary + Gemini 2.5 Flash-Lite checker, Gemini 2.5 Flash arbitrates disagreements (no majority = withheld); every figure deterministically validated (quote located in the document, value in the quote, label keywords per metric, unit scaled to true millions); underlying/diluted figures stored as `underlying_*`/`diluted_eps`; `consensus` + `models` attributes on every entry; benchmark with `bench_direct.py` / `bench_gold.py` before changing the prompt. `--backend gemini` keeps the old langextract path. `director-trade-extractor` runs the same consensus over Appendix 3Y notices (`director_direct.py`: name and every number must be in the notice; a per-share price is multiplied in code; one consideration box over several lots, or over shares plus options, gives no value; a direction contradicting the stated nature is invalid); a failed model call is `model_error`, never recorded as an attempt (the old path recorded it as `no_extract` and skipped the notice for 30 days, which hid a total outage from 2026-07-30); score rule changes with `bench_director.py`. ONE statutory results document per company (filed within 45 days newest first, then companies with no parsed filing or an unread newest document by market cap, then the rest); a document ASX lists under several codes (a renamed company's old and new code, one report for several funds; 4,101 on 2026-10-11) is read once, under its owner (`choose_document_owners`: prices within 7 days of the newest, then ASIC's short report within 30, then market cap, then the code; market cap alone picked the old code for 591), and each run first moves an extracted row filed under an out-of-date listing to its owner (`rehome_shared_extractions`; 290 rows on the first run, e.g. Swift TV's results from SW1 to STV); an EMPTY extraction (no metrics and no usable digest, i.e. none, or confidence missing or under 0.6, the latest-filing gate, the only reader of a row without metrics; a text layer; `extraction_attempts`, migration 000136) is read again at most twice, 7 days apart, at up to 24 pages, after every first attempt in every tier (ranked within its own tier, 121 retries once sat ahead of CBA's unread full year); `task data:review` lists what is still unread, empty or withheld (`.claude/skills/data-review`); the results classifier (both languages, one fixture) also rejects notices ABOUT a result or report (dates, timing, call details, delays, extensions, dispatch, addenda, additional ASX information, clarifications, letters to holders), while re-lodged corrections stay results documents; an extraction not aligned to the document, or whose value's digits are not in the aligned span, is dropped; thinking off; writes `document_meta` (`report_kind` `other` only from the document's own heading). A model failure is never stored (no row, retried next run), 5 in a row stop new work, and the run exits 1 when its model errors look systemic (5, or at least 3 making up at least a fifth of the model calls). `--repair-echo-digests` is the one-off post-deploy repair of digests written from a few-shot echo; `--repair-document-meta` the one after a change to where `document_meta`'s entity or period is read from (no model call, no key). The only source of ASX half-year totals. Read by `-mode filings` |
| Stock page | Financials tab (`components/stocks/financials-tab.tsx`): Latest result, Key ratios, the statements island (`financial-statements.tsx`, the ONLY `use client` file there), the reports list (the source filing marked), the tax card LAST. Overview: `StrategyFitStrip` (one row per strategy, SSR, names link to `/strategies/<id>`, hidden when the fit call fails; the full readings are the Strategy tab, see "Stock page (one route per tab)" below) and `FundamentalsSummary` (crawlable prose, omitted without coverage) |
| Picker web | `components/picks/`, `lib/strategies/`: the Score column is a `ScoreMeter` (a recessed hairline track with an amber fill the length of the score, md+), the Pivot cell prints the close against the pivot (`pctVsPivot`, muted, never red or green), and each hub row carries a `StatusTape` (one band divided triggered / setup / watch over the ranked rows) under its readouts; a native `<details>` row detail (ratios, basis, source, "Full financials": a followed link to the indexable `/shorts/<code>/financials`, prefetch off), `?status=` and `?sort=` via the `picks-sorted-view.tsx` island (both POST to the rewrite; the shortlist's rows stand in while it loads), coverage "fundamentals for N of M stocks (growth figures for K)" only when `fundamentals_rows_count` is reported. The desk (2026-10): five bespoke strategy glyphs as path data in `lib/strategies/glyphs.ts` drawn by `strategy-glyph.tsx` (non-scaling 1.5px stroke, 1.75px at 40px; the only 56px bezel on a view is the strategy page header, which engraves itself on load); the hub is ONE hairline-divided rack (`<ol>`), never a grid of identical cards; the regime banner carries an aria-hidden, text-free ladder (`ladderMarks`) whose legend is the four readouts; statuses are square lamps, rule outcomes round dots. Motion is `phosphor-warm`, `needle-settle` and `trace-draw`, all `motion-safe:`, and the strategy scenes' canvas loop (above), which is the only loop |
| Feature pipeline (PR-09a) | `services/pkg/strategy/features/`: `price.go` `AsOf` is the exact Go port of `mv_price_features` (000130) evaluated at any session D; `regime.go` `Regime` ports `mv_market_regime`; `seams.go` declares the value types the seams name. `pipeline/` (`Inputs`; `CandidateAt` and `BuildCandidates` are implemented in PR-09c) and `snapshot/` (`Row`, `Features` with ex_div, fs1, sf0, sf1) are seams, not yet readers. Container parity: `features/parity_pg_test.go`, untagged and opt-in (`FEATURES_PARITY_TESTCONTAINERS=1`, `make test-strategy-parity`), run by `task check`'s testcontainers leg and by terraform-deploy run-tests. Anchors 2024-01-31, 2024-02-29, 2024-05-31, 2019-04-23 and the real date; fixtures in `testdata/parity/` |
| Feature pipeline (PR-09b): calendar, short readings, days to cover, corporate-action suspects, ordinary universe | `services/pkg/strategy/calendar/` (strategy sessions = XJO bars intersected with ASIC report dates up to the newest report; a report is public the lag-th session after it, the lag a parameter of `New`), `features/` (`ShortReadingV0` = sf0 with no age limit, `ShortReadingV1` = sf1 over the newest complete report at any age, stale past the maximum age, `DaysToCover` / `DaysToCoverV0` (the bars are `stock_prices` rows unfiltered: `DaysToCover` and `CASuspects` drop the closes that fail `validPrice`, `DaysToCoverV0` keeps them as 000080 does), `CASuspects`), `instrument/` (`IsOrdinary`, `IneligibleReason`; the ETP set from `ownership_funds` fund types etf/lic). Pure: no I/O. The strategy calendar is NOT `asxcalendar` and must not leak into the public history API, which keeps `asxcalendar`. Intersecting the two date sources errs toward a later availability date, so a missing session only delays a figure. Open: report age is counted on the intersection calendar, so a gap in ASIC reports shortens it and a stale report can read as current until the spec owner decides. Index dates: the index sync dates each bar by its ASX session (Sydney date, #860), and the one-off full-history re-fetch ran on 2026-11-05 (every XJO, XAO, XKO and XJT row re-dated; no weekend rows left), so `calendar.New` reads exchange dates. `TestShiftedIndexDatesOnlyDelay` still pins that a shifted index date can only delay a report's availability, never advance it. |
| Feature pipeline (PR-09c): `pgsource` readers and `BuildCandidates` | `services/pkg/strategy/pgsource/` (pgx readers shared by the API and the jobs): `Bars`, `IndexBars`, `ASICRows`, `ReportIngests`, `ETPSet`, `CompanyNames`, `Metadata` (name, industry, logo, the guarded `key_metrics` market cap; `MergeMetadata` attaches them, and the industry must be attached before `engine.PrepareCandidates`), `Dividends` (ORDER BY stock_code, ex_date, dividend_type, amount: a total order for ex-dates shared by a final and a special), `CashRate` (monthly; each point carries the latest rate observed strictly before its first day, so no point reads a rate set in its own month; a month with no earlier observation has no point), `ListGrowth` / `GetGrowth` / `ListExtras` / `GetExtras` / `Fundamentals` (moved verbatim from the store). Tolerance: the fundamentals reads treat 42P01 and 42703 as absent; `ListGrowth`, `GetGrowth`, `ReportIngests`, `ETPSet`, `CompanyNames`, `Metadata` and `CashRate` treat 42P01 only; `Bars`, `IndexBars`, `ASICRows` and `Dividends` treat neither. A NULL price, position or count is NaN; a NULL volume reads as 0, as 000130 does. `pipeline.CandidateAt(code, t, in, s)` and `BuildCandidates(D, in, s)` take the version because the rules are the version's: the checks run in order (bar on session, history, instrument, corporate-action guard, short report membership), and the guard holds a code out for `pipeline.CAGuardSessions` (260) sessions counted from the suspect's bar, from its known date. Container suite: `make test-pgsource-pg` (`PGSOURCE_TESTCONTAINERS=1`, `services/pkg/strategy/pgsource/readers_pg_test.go`), gated in terraform-deploy run-tests and `scripts/local-verify.sh` beside the parity suite. `IndexBars` returns XJO/XJT rows dated by ASX session (#860; the full history was re-fetched on 2026-11-05). `PriceCandidateAt(code, t)` (PR-14b) is the index method giving an excluded code its price features (DV20, SMAs, pivot) as of its last priced bar on or before t, whatever the universe decides. The PR-10 daily snapshot reads them under the gate in its landmine above. |
| MCP | `list_strategies`, `get_strategy_picks` (`sort_by`), `get_stock_fundamentals` (`quality`, `coverage`); no new tool |
| Backtest step (pure, no caller yet) | `services/pkg/strategy/backtest/`: `Step` fills at the next traded open with the recipe's cost model, marks on the per-bar total-return basis (a 2-dp payer priced A$1-2 stays total return; the quantum switches at the 4-decimal date), credits cash dividends only on unadjusted bars to the holders at the previous close (a cash-credited bar takes no k step, so its dividend is not counted twice), prices each bar's rounding at its own date's quantum (the first 4-decimal bar carries the previous cents bar's rounding), applies the corporate-action exclusions (a queued exit on the suspect bar waits, and a corroborated suspect is acted on at the open of its publication day) and stale exits. Only `CAGR` (365 days) and `Sharpe` (126 returns) are window-gated; `Summarise` and `MaxDrawdown` report on any window. Nothing outside the package reads it yet |
| Backtest run (pure, no caller yet) | `services/pkg/strategy/backtest/run.go`: `Run(in Inputs, s, r)` makes two passes over the rows. Pass 1 reads every code on every evaluated session (from the session before the recipe's `window_start`) for the eligible universe's rs_6m values and the regime. Pass 2 evaluates each code through `pipeline.Index.CandidateAt` (the built form of `CandidateAt`, the same checks) and `engine.EvaluateOne`, keeps the codes that ever trigger, and `Step` runs session by session over them. `Inputs` is an interface: `MemoryInputs` holds the rows in memory (the golden dataset and tests); the pgsource reader is PR-16a's. The output hash covers records, events and trades. Gates: `golden_test.go` (the seeded dataset committed as CSV under `testdata/golden`; regenerate only with `go test -args -update` after an engine or recipe change, and `TestGoldenDataIsReproducible` holds the CSV to the generator) and `gates_test.go` (order independence, idempotence, future perturbation with adjusted closes, publication timing, the snapshot equality on every code's pick, rule results and rs_6m statistics, a trading day with no ASIC report, the corporate-action guard's corroboration and point-in-time rules, a corroborated consolidation exited on its publication day, a suspect older than the entry block, and the up-jump after the re-sync). Coverage, the same-data reference, sensitivity and identity hashes are PR-14c. Until the one-off index re-fetch has re-dated the older history (Precondition above), a run over stored index bars is not a production figure PR-14b row rules: an admitted code whose stock rules all fail reads none with score 0, keeping its pivot, DV20, SMAs and breakout date; an excluded code carries `PriceCandidateAt` features whenever its history reads, so a corporate-action or recipe exit decided on its session is charged its real spread tier (a stale exit is charged on the position's entry volume). `TestFillsPayTheirRealTier` recomputes each trade's entry fee from its entry row, takes the exit fee as the rest of `Fees`, and fails unless that exit fee is the fee of the basis the simulator charges (the exit row's dollar volume for corporate-action and recipe exits, the entry's for delisted, suspended and barless time-stop exits), or when that basis falls in the lowest tier. The snapshot gate must reach the admitted-but-not-held branch on the golden data (GD24 is that code, never a pick). |
| Viewer depth | `GetStrategyPicks` is one answer to every HTTP caller. With `STRATEGY_PUBLIC_SIGNALS_LIMIT` set (Terraform `strategy_public_signals_limit`, default 0 = off) every HTTP caller (API tokens included) gets the top N rows of the default ranking, and any offset other than 0 is refused with `X-Entitlement-Detail` (`full_signal_list`). Signed-in depth is the private `GetViewerStrategyPicks` (bearer token; `viewer` says `free` or `premium`). The depth is read after the cached evaluation, never in its fill. MCP reads take a verified token through `viewerctx.WithMCPUser` (in-process only) |
| Rules versions | `services/pkg/strategy/spec` (`Registry`, `Live`, `RulesHash` = sha256 of the canonical JSON); served from code by `GetStrategyVersion` and `ListStrategyVersions` (canonical only; an unknown hash is NotFound). Every strategy, picks response and fit names its live version (`StrategyVersionRef`, `StrategyFit.version_hash`); the MCP tools print it as `rules_version`. The version chip sits in the strategy header and provenance line and links to `/strategies/changelog` (ISR, indexable, v0 with its known issues). Add a version by appending a `Registered` entry, never by editing a published one |
| Strategy alert rule language (no DB, no clock): condition catalogue, validation, three-valued evaluation, arming and cooldown state machine, first-evaluation state forms | `services/pkg/strategy/alertspec/` (pure; sessions are caller-supplied ordinals; no caller yet, the alerts job and preview arrive in later PRs) |

**Workspace sub-nav (`app/strategies/layout.tsx`).** The Explore / My strategies /
Signals / Alerts bar is `WorkspaceSubNav` (`components/workspace/`, shared with the
ownership workspace), rendered by the client island `components/strategies/strategies-sub-nav.tsx`
from the registry `lib/strategies/workspace-nav.ts`. Only enabled tabs render: My
strategies is on; Alerts ships later. Signals links to the strategy the route is on, or else to the last strategy viewed
(localStorage in try/catch, default `crowded-short-breakout`); the server knows the first from
the path, so the cached HTML is right without storage. The bar's accessible name is
`Strategy workspace`, apart from the in-page switchers also named Strategies. On a
strategy's own routes the bar does not stick, so the profile tab bar is the one sticky
bar. Every enabled href is held to its page by `lib/strategies/__tests__/workspace-routes.test.ts`.
The changelog's version anchors use `scroll-mt-[124px]`, which clears the sticky chrome.
The layout reads no request data. The bar marks the page's own tab
`aria-current="page"` (`currentStrategiesTab`: Explore on `/strategies`, Signals on a signals page) and,
when the page sits in a section rather than on a tab (a changelog or a profile under Explore),
marks that section tab `aria-current="location"`; ownership passes no `currentTab`, so its markup is unchanged.
The Gamma stylesheets are not imported by the layout yet: the first PR that renders a Gamma component
on /strategies adds `gamma-bridge.css`, `gamma.css` and `DataTable.css` to `app/strategies/layout.tsx` and nowhere else.

**Profile shell (`/strategies/[strategy]`).** `[strategy]/layout.tsx` owns the
params (`generateStaticParams`, `dynamicParams = false`, so an unknown slug is a
routing 404) and renders the breadcrumbs, `components/strategies/strategy-header.tsx`
(registry-only, reads nothing) and `components/strategies/strategy-tab-nav.tsx`
(the client tab bar: intent prefetch, `scroll={false}`, dock-on-switch; the kit's other client module,
`strategies-sub-nav.tsx`, links with `scroll` and has no dock). Tabs live in `lib/strategies/strategy-tabs.ts` and render only
when `enabled`; capability flags in `lib/strategies/capabilities.ts` are all off
until their capability ships, so no Compare, Create alert or Alert-me control
renders before then. The Overview page keeps `StrategyPanel`, the shortlist and
the sorted view unchanged.

**Signals tab (`/strategies/[strategy]/signals`).** The stock-by-rule matrix:
one column per core rule, each cell a pass, fail, unknown or waiting mark with
its word, and the evidence panel for the selected stock. ISR like the profile
(the layout's params, `?sel=stock:<CODE>` read client-side under `Suspense`),
`noindex, follow`, and listed in `STRATEGY_ROUTES` (`web/scripts/route-kinds.mjs`)
and `isr-pages.json`. It reads the same ranked read as the Overview but shows
only the first `SIGNALS_PUBLIC_ROWS` (10) rows to an anonymous visitor; the
status chips and the count line read the API's `status_counts`, so the rest of
the list is counted, not fetched. The panel's stock reading comes from the
public `getSignalStockFit` action, one call per selection, with the code checked
on the server. Its chart is `StrategyLevelsChart` with `keepVolumeOnNarrow`,
because the panel is narrow on every breakpoint. Measures print the comparison
that holds (`−5.7% < −5.0%` for a failing rule), never a false one. No Alert-me
or Create-alert control renders: those capabilities stay off.

**Rules tab (`/strategies/[strategy]/rules`).** The numbers the live rules
version tests each stock with: one row per rule, with its role, its weight as a
share of the score and its parameters all read from the live version
(`GetStrategyVersion`: the role and weight from its canonical spec, the
parameters from its parameter list) and its title from `ListStrategies`; the
universe and data policy; and this strategy's changelog entries. It is ISR, indexable, listed in
`isr-pages.json`, the sitemap and `STRATEGY_ROUTES`. It never repeats the rule
wording (the Overview's `StrategyPanel` owns it), and it renders no Edit a copy
control until the `variants` capability ships. The recipe lines wait for the
recipe fields on the wire (PR-12a).

### Landmines

- **A view change needs its Go port and its parity fixtures moved together.** `features.AsOf` and `features.Regime` port 000130's `mv_price_features` and `mv_market_regime`, and the parity suite reads the view text from 000130 itself. Redefining either view in a new migration without the port fails the suite; changing the port without the view fails it too. Products that feed a comparison (dollar volume, the RS subtraction) carry an explicit `float64(...)`: arm64 fuses an unrounded `a*b+c` and amd64 does not, so the stored value would depend on GOARCH. The index tolerance is seven days at each end of the RS lookup.
- **Fundamentals are in the company's REPORTING currency** (BHP is USD) and
  growth compares like spans only: a year on the year before, 12 months on the
  12 months a year earlier, a half on the same half a year earlier. Yahoo has NO
  half-year totals for ASX companies; halves come only from filings. `*_yoy_pct` is NULL when a side is missing or the prior
  is <= 0, and every nullable number travels with `has_*`. Never COALESCE an
  unknown to 0 (the screener MV defect the MCP tools paper over).
- **FX-converted vendor statements.** Yahoo converts some codes' statements,
  EPS included, and its currency labels for them cannot be trusted (XRO's
  FY25 EPS 1.3541 is AUD-converted NPAT over shares; the NZD figure is ~1.49).
  A fractional value on an integral line sets `stock_fundamentals_sync.fx_converted`,
  every monetary and per-share Yahoo field is rejected (shares kept), Markit
  supplies native revenue/NPAT, filings supply native EPS, and valuation
  withholds P/E and P/B on the flag itself, not only on the currency label.
- **Price-based ratios need AUD statements AND one ordinary share per listed
  unit.** A stock is valued only when `median_k` sits in [0.8, 1.25], or,
  without one, every computable k = NPAT / (EPS x shares) does. `listed-unit` only on
  positive evidence (`median_k` out of band, or without one any positive k
  outside [1/3, 3]): a CDI (RMD, k ~10) gets no market cap, P/E or P/B, never
  a number 10x off. Anything else (no k, a k <= 0, or a recent issuer's k
  between the bands) is
  `no-shares`, and the picker falls back to the screener market cap. A CDI's
  filing EPS is withheld too (`-mode filings` gate 8, stricter: without a
  `median_k` any vendor k outside [0.8, 1.25] withholds it).
- **The engine's constants and the v0 spec are pinned together.** `engine.TestV0SpecMatchesCode`
  holds `spec/v0.go` to the engine's thresholds, weights, far distances and units (the compares are pinned only for the two moving-average rules), and
  `spec.TestFS1ParamsMatchMigrationLiterals` holds the fs1 parameters to the literals of 000130 and
  000080. A threshold or weight change is a new rules version with a changelog entry, never an edit
  to v0 (its hash is published). A rules-only golden change does not bump the engine; an engine
  output change does (`engine.TestEngineVersionBumpedWithGoldens` over `evaluate.golden`).
- **The five r1 recipes are frozen as committed.** `spec.R1Recipes` (`spec/recipe.go`) is the
  execution recipe each strategy's backtest trades, and `spec/testdata/recipe_hashes.golden` pins
  their hashes. A change to a recipe value or to the `Recipe` layout is a new recipe id, never an
  edit: `TestRecipeHashesArePinned` must not be satisfied by regenerating the golden in place, and
  the golden only gains lines. `TestRegisteredRecipesArePinned` holds any recipe a registered
  version carries to the same rules. Recipe prose is not hashed; it changes only with
  `recipe_lines.golden`, and every recipe surface opens with `RecipePreface`.
- **Financials are decided once, in Go** (`services/pkg/strategy/engine/fundamentals_quality.go`):
  banks, insurers and lending financial-services companies get the
  not-meaningful ratios nulled and listed in `not_meaningful`, so
  `cash_conversion` / `leverage` read unknown (never pass) and they rank watch
  at most. Every surface reads that list; do not re-derive it.
  `statement_is_financial` (TRUE = neither operating income nor EBITDA) is
  read from the newest FULL Yahoo income statement (pretax income present,
  revenue and NPAT its own), never from a Markit, filing or legacy row (those
  never carry either line, which once made BHP, CSL and FMG read as banks);
  NULL means the industry decides. Banks and other financials get a
  Go-computed ROE: the view's 10% equity-to-assets guard applies only to
  non-financials.
- **Parsed filings once published the prompt's own few-shot example** (revenue
  $5,142m, NPAT $1,823m, EPS 94.2c) as BHP, CBA, DRO, EDV and MSB results.
  `services/pkg/extractiontrust` is the ONE funnel (grounding, the few-shot
  denylist by TEXT never by value, provenance strip, `IsResultsDocument`) and
  every reader of `financial_report_extractions.metrics` goes through it:
  picks filings, `GetStockFinancialHighlights`, `latest_filing`, the
  weekly-report collector, the digest prompts. A new reader must too. The
  entity check is one rule too (`extractiontrust.EntityMatches`). The reader
  re-applies the entity NAME rules (`cleanEntity`) to every stored row, but
  WHERE in a document its entity and own period are read from is decided at
  extraction (VIT's own 4E was stored as "Cortexa Pty Ltd", from its control
  gained or lost section, with its prior year's period), so after such a rule
  changes one `--repair-document-meta` run (the Report Extractor Repair
  workflow, dry run by default, never while the extractor runs) reads both
  again from every row's stored text with its report date, never removing a
  name readers check or a stated period. Check each recap line of its dry run
  against its document (in the step summary), and while one is wrong
  fix the rule, never run the repair: only a `renamed` entity can make a
  withheld filing pass, and a period line's effect is the stock page's alone
  (picks and the dividend estimate read the same `period_end`).
- **A filing never overwrites a vendor value.** It fills NULL vendor fields and
  replaces only fields marked `field_sources = 'asx-filing-extraction'`. `-mode
  filings` is a fail-closed rebuild in one transaction: exit 10 = REFUSED (a read
  errored or zero extractions: nothing written), exit 1 = rolled back. A large
  purge after a gate change is expected and logged, not refused. A filing's
  net income or EPS takes its sign from its own number or the words that
  govern it, never a comparative's ("compared with a loss", "(pcp: loss ...)");
  an ambiguous sign is withheld (`5_statutory.sign_ambiguous`), never guessed.
- **Prod does not run `migrate up`**, but 000129-000132 are all in the
  terraform-deploy allowlist (replay-safe, catalog-guarded), so no hand-apply is
  needed. 000132 runs on the session pooler before the image swap, as two
  transactions under `lock_timeout = '15s'`: do not merge while
  `financial-report-extractor` or a picks refresh is running. If it cannot
  apply, `task db:prod:apply FILE=services/migrations/000132_extend_fundamentals.up.sql CONFIRM=prod`
  in a quiet window and re-run the deploy; never drop its allowlist line (the
  new jobs image writes those columns). After the deploy, `run_picks_job`
  `filings` then `refresh` clears the echo rows within the hour, one
  `--repair-echo-digests` extractor run (the Report Extractor Repair workflow,
  dry run by default) restores the echo rows' summaries (the API withholds them
  until then), and pre-000132 codes are re-fetched first,
  largest first, over the next nights.
- **000155 puts a trigger on `stock_fundamentals`, the picker's own table.**
  `trg_fundamentals_vintage` writes a `stock_fundamentals_vintages` row for every
  insert, changed update and delete (`I`, `U`, `D`) and a one-time baseline
  (`B`); an update that changes nothing writes nothing. So every write to
  `stock_fundamentals` (the vendor upsert, its pruned CTE, the filings rebuild)
  also writes a vintage, and a failed vintage insert fails that picks write. The
  vintage table is kept forever and nothing prunes it. Its JSONB repeats every
  column in every row, so a vintage table is several times the size of the rows
  it copies: a bulk rewrite of `stock_fundamentals` adds one `U` row per changed
  row, so size it before running it. The first apply takes `SHARE ROW EXCLUSIVE`
  on `stock_fundamentals`, so do not merge during 15:00-18:30 UTC or while
  `run_picks_job` runs. If the deploy's apply times out on that lock, run
  `task db:prod:apply FILE=services/migrations/000155_strategy_capture.up.sql CONFIRM=prod`
  in a quiet window, then re-run the deploy. Change `record_fundamentals_vintage`
  only through a later allowlisted migration, never by hand-apply: the deploy
  replays its `CREATE OR REPLACE` on every run, which reverts a hand fix. Read
  "the latest vintage on or before D" as `ORDER BY captured_at DESC, id DESC`:
  the vintages one transaction writes share a `captured_at`.
- **Every picks row is served three times, so the shortlist is bounded.**
  A ranked row lands in the HTML table, in the Suspense fallback's RSC tree
  and in the sort island's props, each with its fundamentals disclosure.
  With the API's 100 rows that made `/strategies/minervini-trend-template`
  1.85 MB of HTML (measured 2026-10-07). `shortlistRows` caps the server
  shortlist at `SHORTLIST_MAX_ROWS` (40), the island gets `counts` from
  `countByStatus` over every row instead of the rows, and a status chip
  fetches its full list like a sort chip. Do not hand the island every row
  again, and do not add a per-row `<details>` outside the fundamentals cell.
- **The base is anchored.** After a breakout `mv_price_features` reports
  `base_high` / `base_low` / `base_length_days` as at the breakout session, so the
  pivot is the level cleared (the invalidation level), and `base_length_days`
  counts from the FIRST touch of the high (a flat base reads its full length).
  Both were defects found by applying the migration to a scratch Postgres; the
  window is 40 sessions, so a base is never longer than 40.
- **Signal fields (PR-04a).** Each rule's definition (`threshold`, `unit`,
  `comparator`, `has_threshold`) comes from `engine/thresholds.go`, typed out
  again in `TestRegistryAnnotatesDefinitionFacts`; `rs_leader` has no threshold
  (its cut-off is `rs_quantile_threshold`, in points), and neither do `base`,
  `growth` or `eps_growth`, which pass on more than one condition. `rs_6m_percentile` is the
  type-7 rank, so `>= 75` is exactly the top quartile (`TestRS6mPercentileAgreesWithTheRule`).
  A rule's `unknown` says why: `no_fundamentals` for missing inputs,
  `not_meaningful` for a ratio the data withholds (revenue <= 0, the ROE equity
  guard). `status_counts` covers the whole list before any filter or paging.
  The short report dates come from the row the short figure came from
  (`strategyShortDatesQuery`, the view's own filters and figure, no age limit), so a stock
  with no figure has no date and no `short_status`. `short_available_date` is
  empty for a report dated before 2026, the holiday table's first year. The
  universe fill reads `shorts` on the views source (the default; see "Snapshot read"
  below for the snapshot source), so a failed read fails `GetStrategyPicks` and
  `GetStockStrategyFit` (`ListStrategies` reads only the regime). `stale` is set
  when the index has closed a session the prices have not reached, read from the
  regime view and from the index's own series (`latestIndexSession`).
  `ineligible_reason` is a closed vocabulary: a stock outside the universe
  reads `short_history`. Rule `value`s keep the API's precision; the
  mapper rounds only the figures a cut-off reads, rounding down.
- **Signed-in depth never enters a cache.** The Signals island reads a signed-in
  viewer's whole list through `app/actions/strategies/viewer.ts`
  (`getSignalsForViewer`, the private `GetViewerStrategyPicks`) once the session
  is known: the first page (100 rows, the API's cap) at mount. The whole list is
  read only when the viewer searches, filters, sorts or draws past that page, in
  rank order, and is sorted in the browser. The island asks for the whole list at
  most once per mount for a slug and snapshot, so turning a filter, the search or
  the sort off and on draws the list it holds; a failed read is asked again the
  next time the viewer shows more, filters, searches or sorts, and the pane says
  it is loading meanwhile. A read is also held in the tab
  for 60 seconds under the user id, session and rules version
  (`signals-read-cache.ts`, browser memory only). A full read costs one call per 100 signals, and every
  call is metered as the viewer's own browser access. That module imports no
  cache helper, and its guard test reads the source. The Signals ISR page stays
  anonymous: its HTML carries the top 10 rows and the sign-in prompt row, which
  also draws while the session loads. Rows are drawn only when the read's
  snapshot (session and rules version) matches the page's; a read whose page
  differs stops there (`snapshot-mismatch`), so a refresh can refuse it briefly
  until the page regenerates. Its transport, `app/actions/auth-transport.ts`
  (`createSignedInTransport(options)`), reads the session itself and derives the
  verified address from it: a caller passes options only. It fails closed in
  production without `INTERNAL_SERVICE_SECRET`; read-only calls send identity
  only, with no address and no Firebase lookup.

- **Daily snapshot (PR-10, migration 000156, `shorted strategies -mode daily`).** The
  job writes one session's feature rows (`strategy_features_daily`), regime and
  fundamentals blobs, then the live canonical versions' signal events, diffed
  against the previous complete session and recomputed from its stored rows. Each event's `evidence` holds one P, F or U per rule in `r` (services/jobs/README.md, "Signal event evidence"). It
  holds a session whose inputs are incomplete (ASIC sync running, the price sweep
  not completed after 05:30 UTC, priced codes under 85% of the prior median, no
  XJO bar, a weekend-dated XJO bar in its window) and backfills held sessions
  oldest first. Dry run unless `STRATEGIES_DRY_RUN=false`. Container suite:
  `make test-strategies-daily-pg`. Admin `strategy_status` (`jobs:read`) reports
  the phases, holds and table sizes, aggregates only.
  **Index dates are fixed in the tree (#860).** The job reads stored XJO dates for the data calendar, the regime
  and RS. Rows inside the scheduled index window (`-years 2`) are dated by ASX session once the index sync has run;
  the one-off full-history re-fetch ran on 2026-11-05, so older history is re-dated too, before the job's
  first session (a completed features phase is read back, never recomputed).
  Readiness rule (e) holds with `xjo_weekend_rows` while any XJO bar in the window
  is dated on a weekend, so a deploy ahead of the fix holds and pages rather than
  writes. Merge PR-10, and enable writes, only after
  `task db:prod:psql -- -At -c "SELECT count(*) FROM index_prices WHERE index_code = 'XJO' AND EXTRACT(ISODOW FROM date) > 5"`
  returns 0 (481 on 2026-11-05); that whole-table count also needs the one-off
  `-years 21` XJO re-fetch. Runbook (recompute, a dead session, the spot check):
  `services/jobs/README.md`, "Strategy daily snapshot".
- **Snapshot read (PR-11, `STRATEGY_SOURCE`).** `views` (the default, and what
  production runs until PR-11b) keeps the SQL views. `snapshot` evaluates the
  newest completed session of the daily snapshot (`ReadStrategySnapshot`: the
  newest two sessions whose features, evaluation and events phases all completed,
  then that session's `fs1` rows, blobs and regime). The Terraform variable is
  `strategy_source` on `terraform/modules/shorts-api` (set to `"views"` in
  `terraform/environments/prod/main.tf`); PR-11b is the one-line change to
  `"snapshot"`. A database without 000156 (42P01) or with no whole session serves
  the views and logs at warn or error. Any other snapshot error fails the read.
  Snapshot reads: the picks, the fit, the status counts, `session_date`,
  `short_report_date`, `stale`, the short availability date (the stored sf0 date,
  empty for a report before 2026 as on the views) and `ListStrategies`' regime
  (the universe's under `snapshot`; the views' only when the universe read fails).
  Not from the snapshot: the data status' availability calendar (the ASX calendar). `GetStrategyDataStatus` (public, cached 5 min per instance) reports
  the sweep, the snapshot session, the priced count, the newest 10 ASIC reports
  and `next_update_utc` (13:00 UTC on the next trading day under `snapshot`,
  13:30 under `views`). `ListStrategySignalEvents` (private) serves the canonical
  live or superseded versions from `live_from` only, keyset on `id`; a variant or
  unregistered hash is NotFound, and a registered version that is neither live nor
  superseded reads no events. Container suite: `make test-strategy-snapshot-pg`, which
  gates the deploy. Live check: `scripts/strategies/snapshot-cutover-check.mjs`
  (`record` pages every list to `total_count` and fails on a clamped read; pass
  `--token-env` once the public depth clamp is on; `diff` requires both recordings
  to be one session and the after recording to be the snapshot's).

### Saved strategies and My strategies (`/strategies/my`)

- **Table `user_saved_strategies` (migration 000157, allowlisted after the strategy capture migration, before the 000138 closer).**
  The key is `(user_id, strategy_ref)`; `strategy_ref` is a canonical id or `variant:<id>`. Nothing is granted.
- **RPCs** `SaveStrategy`, `UnsaveStrategy` and `ListSavedStrategies` are `VISIBILITY_PRIVATE` on
  `StrategyService`, mirrored on the legacy service. The owner is the verified uid only. The cap is 20
  (`shortsstore.MaxSavedStrategies`): the save takes a per-user advisory lock, so the cap is exact under
  concurrent saves, and a repeat save succeeds at the cap. A save past the cap is `PermissionDenied` with
  `X-Entitlement-Detail` naming `cap_reached` (the web reads that detail, not the code). A save waits at most
  one second for the lock and otherwise answers `Unavailable`, so a retry is safe and the pool is never parked.
- **Variant refs** resolve under the caller through `strategy_variants` (the variants migration when it lands;
  it must exclude soft-deleted rows). A database without that table owns no variant, so a variant save is `NotFound`.
- **Web**: the static shell `app/strategies/my/page.tsx` and `my-strategies-island.tsx`. The server actions
  are `app/actions/strategies/saved.ts` (identity only, no cache). The Save control is
  `app/strategies/save-strategy-button.tsx` on the Signals header. It is gated by the `saves` capability and
  by a signed-in session. Only `saves` is on among the capabilities.
- **Tests**: `services/migrations/strategy_saves.test.mjs`; `shorts/internal/services/shorts/strategy_saves_test.go`
  (unit); `make test-strategy-saves-pg` (container: the cap under 25 concurrent saves, the variant guard, replay).

## Strategy chart primitives and returns kit (PR-17)

Primitives only: no page uses them yet (PR-19 Backtest and PR-20 Explore do).
They are in place so the chart and table code is reviewed once.

- **`StockChart` extensions are default-off.** A chart with none of them renders
  byte-identically. `StockChartInner` props and series fields: `series.dash`,
  `series.endLabel` (read from the drawn points, so a zoom and the normalised
  view are right), `regions` tone `"live"` (a token tint, its label written on
  the band when it fits; `bearish`/`bullish` stay fixed hexes), `levels[].tag`
  (a boxed label, spaced 15px), `events` (dots in the entry, exit and neutral
  tokens), `annotations` (a plot callout), and `oscillators[].kind = "area"`
  with `oscillators[].annotations` (a drawdown panel, with true-minus ticks and
  its trough callout on the panel's own domain). Line oscillators keep their
  output (Williams %R has negative levels).
- **Returns kit**: `components/strategies/` holds `ReturnsHeatmapTable`
  (server `<table>`, `span` merges columns, a bin is taken from the figure as
  printed), `CoverageStrip` (`rows` or a `columns` month strip), and
  `EquitySparkline`. The bins, fills and contrast live in
  `lib/strategies/returns-scale.ts`. `.hatch-empty` (state), `.hatch-bar`
  (a coverage bar under 80%) and `.hatch-on-fill` (the hatch inside a filled
  cell) are the three hatch utilities in `styles/globals.css`.
- **Guards**: `components/strategies/__tests__/colour-rules.test.ts` (no market
  mark token, raw hex or Tailwind red/green utility in the kit) and
  `client-boundary.test.ts` (the import walk reaches no `~/gen`, protobuf,
  `@connectrpc` or server action, and no kit file is a client component).
  `returns-scale.test.ts` checks the ink on every fill and on every filled
  cell's stripes, in both themes, against the real tokens in `globals.css`.
- **Recorded deviations from the spec (1.5 and 10.6-10.8)**: the StockChart
  colours stay the existing hexes, so existing output is unchanged (the spec
  asked for semantic tokens); the returns cells mix over `--returns-paper`
  (a new token, light sand in dark) rather than `var(--background)`, which
  keeps the ink above 4.5:1 in both themes; a `CoverageStrip` month row is the
  `columns` layout here rather than a separate primitive.

## Stock page (one route per tab)

`/shorts/[stockCode]` is a shared server `layout.tsx` (breadcrumbs, then
`StockHeader`, then the sticky `StockTabNav`) with seven ISR pages beneath it
(3600 s; `/news` 600 s): `/` (Overview digest), `/short-interest`,
`/strategy`, `/financials`, `/company`, `/news` and `/community`. The thread
pages at `community/[threadId]` render under the same layout but stay
per-request. The tab list lives ONCE in
`web/src/@/lib/stocks/stock-tabs.ts`; tab metadata goes through
`lib/seo/stock-tab-metadata.ts` (`stockTabMetadata` for the five newer tabs,
which inherit `isStockIndexable`; Strategy adds noindex when `in_universe` is
false, Short interest adds it (`noindexWhen`) when the stock read resolved and
reports no short position, and Community is always noindex; Overview and News
keep their own titles and share `stockOgImage`). An indexable page sets NO
`robots` key: Next merges metadata with `for (key in source)` (checked on 15.5.28,
`lib/metadata/resolve-metadata.js`), so `robots: undefined` would replace the root
layout's googleBot snippet and image-preview directives with nothing.
Specs: `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md`
(one route per tab) and
`docs/superpowers/specs/2026-10-10-stock-page-visible-first-design.md`, which
amends it in three places: the layout chrome above the tab bar, the chart in
the layout and the theme chips in the layout. Where the two differ, the second
governs.

### Chrome, charts and the readout (2026-10-10)

Production (BHP, signed out, 2026-10-10) put the tab bar 1258px down on a
1280x900 desktop and 1774px down on a 390x844 phone, beneath a sign-in banner,
two cards, a summary, theme chips and a 420px chart. The layout now holds three
blocks, each followed by 16px (`mb-4`): the breadcrumbs, `StockHeader` and
`StockTabNav`. It loads no chart. `web/e2e/stock-tabs.spec.ts` pins the goals
(no workflow runs it): the tab bar at most 340px down on the phone and 280px on
the desktop, the tab's own content at most 400px and 340px down, the Overview
chart whole inside the phone's first screen, and layout shift under 0.02 on
first load and on a tab switch.

`StockHeader` is a server component: the logo (its only client child, read
inside `Suspense` in a fixed box so it cannot shift the header), the code, the
industry badge, the name, and the short-interest readout (short %, the 30-day
change in percentage points, reported shorts, shares on issue and the "as of"
date). The readout is the page's one lit surface (`shadow-terminal-inset`,
DESIGN.md's One Bloom Rule). The 30-day change is coloured by its rounded
direction (2026-10-19, at the owner's request): a rise in short interest is
signal red, a fall green (as the industry panel colours it), no change the
foreground; a fall takes U+2212. It is the only coloured figure in the header.
A missing value is left out, never a dash or "undefined".

`StockTabNav` is sticky at `top-16`, under the site header's `h-16` row, and
bleeds to `<main>`'s edges with `-mx-8`; the scrolling list inside carries the
`px-8`, so on a phone the tabs scroll to the screen edge. Its links pass
`scroll={false}`: Next's own scroll on a tab switch (`ScrollAndFocusHandler`,
`client/components/layout-router.js`, checked on 15.5.28) does nothing when the
new tab's first node is already in view, which leaves its first ~110px under
the two bars, and jumps to the top when it is above. So a click sets a flag,
and when the active tab changes a layout effect scrolls to `dockY` (the
sentinel's document top minus the bar's sticky top) only when the page is
scrolled past it. A bar that was not docked does not move, and back and
forward keep the scroll the browser restores. Intent prefetch is unchanged. A
hash target in a tab page takes `scroll-mt-[124px]` (64 header + 44 bar + 16).

Two more things live in `StockTabNav`. The list fades the edge that can scroll
(a 40px `mask-image`, driven by `data-scroll-start` / `data-scroll-end`, which
its scroll event and a ResizeObserver keep): the scrollbar is hidden and at 360
and 375px nothing of the fourth tab peeks out, so the fade is the only cue the
row scrolls, and a bar that fits (a desktop) draws none. And a document
`focusin` listener keeps keyboard focus out from under the docked bar (WCAG 2.2
SC 2.4.11): a `:focus-visible` control outside the bar, the site header, any
dialog and any `position: fixed` ancestor, with its top above the bar's bottom
+ 8px and its bottom on screen, is scrolled to sit 8px under the bar. It is not
CSS `scroll-padding-top`, which makes Tab across the docked tab links scroll the
page to the top; `stock-tabs.spec.ts` holds both.

**A price chart lives only on the tab it is about.** `StockChartPanel` is the
first block of the Overview (combined view, `prefsKey` `"<CODE>:overview"`) and
of Short interest (the short view, or combined for a stock with no short
history, `"<CODE>:short-interest"`), always client-only (`ssr: false`).
Strategy keeps its own levels chart; Financials, Company, News and Community
have none. The visitor's settings survive a tab switch in `chart-prefs.ts`, a
client-only module store: the period is kept per stock and shared by both chart
tabs, the view, indicators and divergence per `prefsKey`. It lives until a reload
and writes nothing to storage; a panel with no `prefsKey` (the dashboard, the
stories) is plain local state.

**Nor does a tab without a chart load one.** Next builds each tab's client
reference manifest from the Overview page's (the page above the other six; checked
on 15.5.28, `build/webpack/plugins/flight-manifest-plugin.js`), and
maps each client module to the whole first-load chunk list of the page that
holds it, so a tab that resolves a shared module (`next/link`) through the
Overview's mapping downloads all of the Overview's first-load chunks. A
On 14.2, a `nextDynamic` in a server page was bundled into that list: Financials
and Community downloaded the Overview's chart that way (227 KiB of JS for BHP). A
route group does not stop it (Next strips the group from the manifest's group
name). So the Overview and Short interest load the panel through
`StockChartPanelLazy` (`components/charts/stock-chart-panel-lazy.tsx`), and
Strategy loads its levels chart through
`components/strategy/strategy-levels-chart-loader.tsx`. Each is a `"use client"`
module whose `next/dynamic` is a real `import()`: the chart is a chunk of its
own, in no list another tab inherits. A server page may not call
`next/dynamic` with `ssr: false` (Next 15 refuses it), so the charts come
through these client modules. The panel's module starts that download as it
runs, so the chart lands when it did as a first-load chunk, but only when the
path is the Overview or Short interest: a tab that loads the Overview's page
chunk runs every Overview client module, and the unguarded `import()` put the
chart back on Financials and Community. `web/scripts/stock-chart-chunks.mjs`
(`npm run routes:charts` after `next build`; `task test:bundle` and
`perf-budget.yml` run it) fails when any stock tab's client manifest maps a
module to a chunk carrying the chart's code (`data-chart-capture`), when a chart
route's manifest stops mapping its loader, or when the loader's import in
`.next/react-loadable-manifest.json` stops listing that chunk. It cannot see an
`import()` started at runtime; the download check in
`web/e2e/stock-tabs.spec.ts` can (no workflow runs it).

The chart box is sized by CSS, `h-[360px] sm:h-[420px]`
(`CHART_BOX_HEIGHT_CLASS`), and `StockChart` takes its height from its parent
when it is given no `height`. One `StockChartPanelSkeleton` serves as the
dynamic import's `loading` fallback and as the first block of both chart tabs'
`loading.tsx`, so the placeholder and the chart are the same size. The controls
stack below `xl`: one 40px row above the plot (the view control and the embed
button), then the period and the toggles beneath it. From `xl` they sit in one
row, which needs about 975px of panel (at a 1280px window beside the signed-in
sidebar the toggles row scrolls about 15px, see **Indicators** below); every
narrower window gets the stacked form.

`StockChart` takes `readout?: "strip" | "tooltip"`, default `"strip"`. The
strip is a fixed-height band above the plot, so nothing covers the plot: 28px
from 640px wide, and below that `8 + 18 x (1 + series)` (44px for one series,
62px for two). Its height depends on the chart's width and its series count
only, never on the state or the values. The count is the series it has, or the
`readoutReserveSeries` it is told to expect if that is more: the Combined panel and
the embed's Combined view pass 2, so on a phone the short series landing after the
price finds its row held and moves nothing (the rows of series still to come are drawn empty). It
reads `latest` by default, then `hover`, `pinned` or `measure`
(`data-readout-state`). A persistent `sr-only` `role="status"` announces a pin
and its release, never a scrub, and the arrow keys step a reading from the pin,
or else the point under the pointer (Home and End jump, Escape releases).
`"tooltip"` is the floating card: the two dashboard widgets pass it, so does
the embed when its chart is under 260px tall, and the strip falls back to it
when the plot would be under 160px (`READOUT_MIN_PLOT`). Red and green mark the
price series' direction only; the short series reads in the foreground, in
percentage points, in the header's 30-day change format ("▲ +0.62 pp",
"▼ −0.31 pp", "– 0.00 pp"; the header colours its figure, the chart does not). Short interest prints to two decimals everywhere
the chart prints it (`shortFmt`). A reading is dated by the data point it
shows, never by the pointer's instant: the strip, the card, the measure's
headline and the pin's announcement all name the session, not a weekend the
cursor happens to be over. The svg clips whatever is drawn outside it, so the
margins follow the labels (`axis-margin.ts`): a side with an axis gets the room
of the widest label it prints, and never less than 48px, which holds six
characters at 10px mono after a tick and a gap ("$99.99", or short interest as
"12.00%"). A price of $100 or more is seven characters and gets 53px. The labels
are estimated from the data and the axis' format (the zoom, the normalised view,
the same ticks the axis draws) and never measured, because the margin sets the
plot's width. A zoom can widen a side but never narrows it: a side keeps the
widest that the whole series or any zoom since has needed, until the data, the
view or an axis changes, so a zoom whose widest label is a character shorter
does not move the plot 5px under the pointer. With no right axis the right keeps 28px (the time axis' last label
hangs half its width past the plot), and a compact chart its 32px and 12px.

Volume (the Price and Combined views, wider than 500px) is a grey bar per
session in the bottom 28% of the plot on a scale of its own, all ONE path
(`volume-bars.ts`). It is read, never left unlabelled: the strip's `Vol` entry
follows the series on one row and sits in the headline row on a phone (it adds
no row, so the strip's height rule stands), the card has a Volume row, the bar
under a reading is highlighted, and a measure leaves it out. A reading takes
volume from the RAW points on screen, never the decimated bars. The brush band
draws the one series spanning the most time (`brushOverviewPoints`): merged, a
$4 price and a 9% short position alternated day by day into a grey comb.

The sign-in banner renders on the Overview only, after the About card, as one
44px line. Under `html.anon`, `critical-css.ts` reserves its `.login-slot` at
46px (the line plus the wrapper's 2px border) with a 1rem margin, so the slot
is the same height before and after the banner mounts. The site header's Sign
in button stays on every page. The Strategy tab's `RegimeBanner` takes
`compact` below `sm` (the pill, the as-of date and the verdict, without the
four readouts and the ladder); on `/strategies` it is unchanged.

**Indicators.** The toggles row holds an **Indicators** trigger in every view:
an icon below `sm`, the word from `sm`, and a count badge when any are on. From
`xl` the one row needs about
975px (at a 1280px window beside the signed-in sidebar the toggles row scrolls
about 15px, as it was built to). The menu is a panel inside the chart box, CSS
positioned (`indicator-menu.tsx`): the base set for everyone, the advanced set
(SMA 200, Bollinger Bands, RSI, MACD, the 90-day short average) behind a session.
An overlay draws on its series' own axis and widens the value axis
(`indicatorsInDomain`); the legend sits inside the plot's top left
(`indicatorLegend`), its width estimated from its labels at `AXIS_CHAR_PX`
(6.1px a character) and never measured, as the axis labels are. At most one panel shows, under the time axis (it used to
overlap the labels' bottom 8px). An indicator whose lookback is more than a tenth of the window on screen (sessions for price, calendar days for short interest) fetches the first longer period that covers it, once, through that period's own query keys (`planWarmup`): 1M with SMA 50 fetches 6M, 2Y with SMA 200 fetches MAX, and SMA 20 at 1Y fetches nothing. Short interest never warms up from MAX, which is weekly buckets. A longer history this chart has already loaded, its own visible series included, serves the indicator when it covers the lookback, and nothing is fetched (`useIndicatorHistory`). That history lasts only while the chart stays mounted: a remount (a stock-page tab switch, or leaving a stock and returning to it in the Activity) asks for the longer history again, and TanStack's cache may answer from memory. Each indicator waits for its own history
(`readyIndicators` with `history.waiting`), and a waiting panel is drawn empty
(`buildChartView` `pending`), so the plot keeps its height. The menu follows the
view the chart is drawn as (`resolveChartView`: a Combined chart with one series
is that series' view), and a selected indicator the series is too short for says
so ("Not enough history") and is not counted in the trigger. The StockChartEmbed
follows the same rules. `ChatSidebar` and both environment banners read
`isChromelessRoute`, as the header does.

### Landmines

- **Every tab page exports `revalidate`, `dynamicParams = true` and an EMPTY
  `generateStaticParams`**, and nothing under the segment reads
  `searchParams`, `cookies()`, `headers()`, `auth()` or a no-store fetch. Lose
  any of that and the route renders on every request. Three guards, each
  blind to something the others see:
  - `web/scripts/route-kinds.mjs` (`npm run routes:kinds` after `next build`;
    `task test:bundle` and `perf-budget.yml` run it) fails when a stock route
    is missing from `dynamicRoutes` in `.next/prerender-manifest.json`. It
    catches a lost `generateStaticParams`, `revalidate = 0` and
    `dynamic = "force-dynamic"`. It does NOT catch a `cookies()`, `headers()`
    or `searchParams` read under an empty `generateStaticParams`: nothing
    renders at build time, so the route stays listed and fails at request
    time.
  - `web/src/app/shorts/__tests__/isr-source-safety.test.ts` (Jest) covers
    that half: it scans every non-test file in the segment for those reads and
    requires the trio in each tab page (the thread page is exempt; it is
    per-request by design). It reads the segment's own files only. A read
    inside a component imported from elsewhere is caught only by the e2e
    check that a second request to each tab answers `x-nextjs-cache: HIT`
    (`web/e2e/stock-tabs.spec.ts`; no workflow runs it) and the post-deploy
    HIT check.
  - `web/src/app/shorts/__tests__/ssr-import-safety.test.ts` (Jest) walks
    static imports from the layout, the data loader and every tab page, and
    fails when a `"use client"` module on the way reaches `@connectrpc` (the
    SSR failure under Known Issues). Client widgets load through a `"use client"`
    loader (`*-loader.tsx`) that holds `nextDynamic(() => import(...), { ssr: false })`:
    the page imports the loader, and the loader is listed in the test's
    `CONNECT_ISLANDS`. A server module never calls `next/dynamic` with
    `ssr: false`, and a test checks that across `src`. The two chart tabs share
    one loader, `stock-chart-panel-lazy.tsx`, and a test checks that no tab's
    loader is reachable from another tab. The walk's allowlist, `KNOWN_CLIENT_CONNECT`, holds only
    the pre-existing `company-info-with-retry` fallback (on the Overview) and
    can only shrink. The layout's two twins, `company-profile-with-retry` and
    `company-stats-with-retry`, were deleted with the cards they served, and
    `StockHeader` is a server component with no twin, so the layout has no
    entry. An allowlist entry is a risk, not a fix: `CompanyTaxCard` was on it,
    and the Financials route then answered 500 for every stock in a production
    build with every Jest test green. It is an island now.
- **A transient stock read fails the render; it never degrades it.** The
  layout, the Overview and the Short interest, Strategy, Financials and Company
  pages read the stock through `loadStockOrFail(code)`
  (`web/src/app/shorts/[stockCode]/stock-page-data.ts`): an unknown code is a
  404, a transient `undefined` throws, so a degraded shell is never baked into
  the cache for an hour. The News page applies the same rule to its own read: a
  failed `getStockNews` (undefined) throws, while an empty feed (a response
  with no articles) keeps its "No news found" copy. `[stockCode]/error.tsx`
  covers the tab pages, not the layout (a boundary sits inside its own
  layout): a throw from the layout renders the root error page with HTTP 500
  and caches nothing. A page that is merely stale keeps being served while it
  regenerates, so a failed regeneration leaves the last good one in place; but
  the sync's layout revalidation EXPIRES every entry, so the next regeneration
  is blocking and a transient read can show that error page for a stock that
  was cached too, until a retry succeeds. A
  `notFound()` from the layout is caught one level up, so
  `web/src/app/shorts/not-found.tsx` re-exports the stock 404 card. Do not add
  `app/shorts/error.tsx`: it would wrap the `/shorts` index too.
- **Tab links prefetch on intent only** (`StockTabNav`: pointer enter, touch
  start, focus; once per href). Never switch them to viewport prefetch: seven
  ISR regenerations per page view. Every other link into a tab follows suit:
  build it with `stockTabHref(code, tab)` and `prefetch={false}` (the stock
  breadcrumbs pass `prefetch={false}` to the shared `Breadcrumbs`, whose
  default is unchanged for the other pages; the News links in `take-related.tsx`
  and `stock-news-tab.tsx` do the same).
- **A missing community thread answers 200, not 404.**
  `community/[threadId]/page.tsx` calls `notFound()` for an unknown or deleted
  thread, but the segment's `loading.tsx` streams the layout before the page
  runs, so the status line is already sent: the response is a 200 carrying the
  not-found card and Next's `noindex` meta. A crawler reads a soft 404, and the
  `noindex` is what takes a deleted, once-indexed thread out of the index. The
  ISR tab pages are unaffected (static generation renders to completion before
  anything is cached). A `generateMetadata` that noindexes a missing thread is
  the alternative to accepting this.
- **Old `?tab=` links are edge redirects.** The map and the redirect builder
  live in `web/src/config/stock-tab-redirects.mjs` (dependency-free, so the
  repo-hygiene job can import it; there is no JSON file) and are spread into
  `redirects()` in `next.config.mjs`;
  `scripts/tests/stock-tab-redirects.test.mjs` pins both. `?tab=overview` is
  deliberately NOT redirected: Next forwards the query string, so a same-path
  redirect would loop on itself. It renders the Overview, like any other
  unmapped value. No client-side reader exists any more. Under `next start` the
  redirect's `Location` keeps the stale `?tab=`, so the e2e test compares its
  pathname.
- **The sync's `/shorts/[stockCode]` path is revalidated with type `layout`**
  (`/api/revalidate`), which expires every tab for every code in one call. An
  expired page regenerates only when it is next visited.
- **A chart is no longer one DOM node across the tabs.** Each chart tab mounts
  its own, so a return to one within 30 minutes (the chart queries'
  `DAILY_STALE`, and the client's `gcTime`) re-renders from the TanStack cache
  with no request, and its settings come back from `chart-prefs.ts`. The
  Strategy levels chart calls `useStockChartData(code, "1y")`, the default
  period and query key of those charts, so its 1y queries are shared with the
  Overview chart only after a visit to a chart tab. A visitor who lands on
  Strategy directly pays one extra request; the layout's chart used to fetch
  the prices first.
- **`PriceFeatures` on `GetStockStrategyFit`** carries `has_` flags; the web
  maps absent to `null` (`StockPriceFeatures`), never zero, and the fit's
  `unstable_cache` key is `v3` so no entry without the signal fields is read back
  (the picks and strategies-list keys are `v3` too).
  Level sets are pure (`components/strategy/strategy-levels.ts`); after a
  breakout the base band and its ranged pivot end at the BREAKOUT session, not
  the last close, because the features are as at that session ("The base is
  anchored" above); a moving-average line is drawn only with a full lookback. A
  stock outside the
  picker universe (under 60 sessions in the last 400 days, migration 000130)
  gets an explanation and `noindex`, never a chart with empty levels.
- `stock-news-tab.tsx` stays (`stock-news-feed.tsx` and `related-news-rail.tsx`
  import its hooks); the old `stock-tabs.tsx` shell is gone.
- **The Company tab draws its director trades on the server.** The page
  starts `getDirectorTrades(code, 20)` with its other reads and awaits it where
  the section renders (the ISR-safe fetch the insider-trading page uses; it
  resolves `undefined` on any failure, and a rejection is taken the same way),
  then draws `DirectorTradesView` from it: the table, or the "No director trades
  found" card. That module (`components/company/director-trades-view.tsx`) has
  no `"use client"`, no Connect and only type imports from the generated code,
  and the `DirectorTradesTable` island draws it too for its loaded and empty
  states, so the markup lives once. The island, under its
  `DirectorTradesSkeleton` placeholder, is only the fallback for a read that
  returned `undefined`. It used to be the only path: for a stock with no trades
  its 322px skeleton collapsed to a 92px card, moving every card below it up by
  230px (a first-load layout shift of 0.164 at 1280px and 0.215 at 390px for
  SPLR on a local production build; BHP, which has trades, was 0.0007).
  `PoliticianInterestsCard` had the same flaw one card lower (a 134px skeleton,
  then `null` for most stocks): it renders `null` while it loads, as
  `StockConnections` does, so a card that may resolve to nothing never holds a
  place it gives back.
- Every tab segment has a `loading.tsx` whose root is `role="status"` with
  `aria-busy` and `aria-label` (a bare `aria-label` on a div is not announced);
  `app/shorts/__tests__/loading-boundaries.test.tsx` finds them on disk. Where
  a tab's first card follows the sr-only h1 (`CardTitle` is an h3), the page
  carries one sr-only h2 naming the group so the outline never jumps a level;
  a title an island already prints is never repeated by a wrapper heading.

## Ownership (who holds ASX stocks)

`/ownership` (hub: the map by kind, biggest holders, crowded registers, crowded
both ways, lending desks, index fund ownership, super funds' consensus, latest
notices, institutions directory), `/ownership/[slug]` (one institution),
`/ownership/stocks/[code]` (one stock's register: the Holder Lanes, the
holders, the index fund and super option rows, the notices trail),
`/ownership/notices` (the feed: every notice read, newest release first, with
window, event, kind, stock and holder filters and the window's weekly bars)
and `/ownership/stocks` (the registers list: eleven sorts, industry, kind,
interest and short-position floors, a code or name query), the workspace
(`/ownership/map`, `/connections`, `/activity`, `/funds`, `/funds/[fund]`,
`/holders`, `/changes`: one sub-nav, one toolbar row, one right-rail inspector
driven by `?sel=`) and, on the
stock page, the "Substantial holders" card on the Company tab (`#ownership`,
the summary) and the one-line strip on the Overview, over `OwnershipService`
(`ownership.proto`, 14 rpcs, all public, mirrored on `ShortedStocksService`).
Fed by `shorted ownership` (`services/jobs/README.md` "ownership"): a curated
registry of ~145 institutions, APRA's super fund statistics, ASX's ETF/LIC
report, 11 index funds' holdings files, 11 super funds' portfolio holdings
disclosures, and every substantial holding notice PDF since 2024. Migration
`000137_add_ownership` is in the deploy allowlist. Spec:
`docs/superpowers/specs/2026-11-02-ownership-explorer-design.md` (stages 1 to 4 built: section 13 is the desk, 14 the workspace; 7.1, 13.8, 14.7,
14.8 and 14.9 hold the decisions taken in review; 14.11 holds the backlog
pass of 2026-11-04 and 2026-11-05, `2026-11-04-ownership-workspace-backlog.md`,
nineteen items built in five waves and measured against a local production
build; the Short interest lending line, the register OG lanes and the e2e spec
remain specified and unbuilt).

| Piece | Where |
|---|---|
| Job, parser, registry | `services/jobs/internal/jobs/ownership/` (`notice.go` parser, fixtures in `testdata/notices/`; `registry.go` kinds, aliases, groups; `repair.go` the `-mode repair-placeholders` dry run) |
| API | `services/shorts/internal/services/shorts/ownership.go` (handlers assemble every response from ONE cached universe, `ownership_universe.go`: built once per `ownershipTTL` from 11 statements, refreshed in the background two minutes ahead of expiry, never served past it; a stock's or an institution's notices and the feed's first page are the per-key statements, cached under the universe's generation; `ownership_lists.go` holds `ListSubstantialNotices` (a keyset cursor `YYYY-MM-DD|url`, windows rounded UP to 7/30/90/365, 0 = every notice read) and `ListStockRegisters` (in memory over the universe, never cached per query), with every clamp mirrored in `web/src/@/lib/ownership/__fixtures__/clamps.json`, which a Go test and the web test both read), `store/shorts/postgres_ownership.go` (a schema without 000137 reads empty, never a 500; `eventOf` classifies a notice's event ONCE here: ceased, then 603 became, then 604 increased / decreased / changed, then nz) |
| Desk | The hub's instruments over one window of time, `components/ownership/desk/`: the map (`ownership-map.tsx`, a d3-hierarchy treemap of sectors and stocks, area = market cap, disclosed exposure or index fund holdings (Size), seven lenses (the last, index_flow, is the index fund change), a sector zoom and a stock panel), flows (`ownership-flows.tsx`, a d3-sankey from holder kinds to sectors by disclosed exposure, estimated, with a changes-in-the-window toggle), movement (`movement-heatmap.tsx`, sectors by week with a two-handle brush), index fund positions (`fund-positions.tsx`, a two-handle date slider over the funds' snapshot dates, the largest weight changes, per-fund series). Each has a `-static.tsx` twin the server renders from the pure layouts (`map-layout.ts`, `flows-layout.ts`, `fund-changes.ts`), one URL state (`desk-state.ts`: window, lens, sector, since/until, from/to, sort) and loaders in `app/actions/ownershipDesk.ts` over five rpcs (`GetOwnershipMap`, `GetOwnershipFlows`, `GetOwnershipActivity`, `ListFundPositionChanges`, `GetStockFundSeries`; `ownership_desk.go`). Colour is `desk-scales.ts` over the theme's stops in `globals.css` (`--desk-bin-N` with an ink token per stop, the diverging `--desk-fall-N`/`--desk-rise-N`, the short lens's `--desk-short-N`; `desk-ramp-contrast.test.ts` reads the CSS); below sm the map is `phoneLayout` (map-layout.ts), a two-column square of sectors; a Sort control (`workspace/sort-control.tsx`, `?sort=largest|changed`) orders the map (under a diverging lens), the heatmap, the holders directory and the fund exposure map by what moved |
| Workspace | The instrument pages. The shared kit is `components/workspace/`: `workspace-page.tsx` (the shell: the content column and the rail), `toolbar.tsx`, `workspace-sub-nav.tsx` (`WorkspaceSubNav`, the registry-driven bar that Ownership and Strategies both render) and `selection-tray.tsx` (`SelectionTray`, the sticky compare strip the funds page uses). `components/ownership/workspace/` keeps the ownership parts: `ownership-nav.tsx` (`OwnershipNav`, a thin wrapper over `WorkspaceSubNav` with the registry in `nav.ts`), `inspector.tsx` (the right rail from lg, a `SideSheet` bottom sheet below it, the content a plain contract from `inspectors/*` built in pure functions and loaded by `loadInspector` in `app/actions/ownershipDesk.ts`), `selection.ts` (the `?sel=` grammar: `stock:PLS`, `holder:vanguard`, `connection:index_manager>Materials`, `cell:Materials@2026-10-26[:kind]`, `fund:asx:A200`, `holding:asx:A200/BHP`; 280 characters at most, parsed never trusted), ONE row of labelled selects or segmented controls per page, folded under `view-disclosure.tsx` "Adjust view" below sm (`window-select.tsx` the shared Window select; `sort-control.tsx` the Sort control), `method-disclosure.tsx` (the one-line "How these figures are read" every page ends with), `trail.ts` (the rail's trail of selections, sessionStorage), `week-strip.ts` / `week-strip-view.tsx` (a stock's or a holder's notices by week, the rail's "weeks" section), the readings (every `inspectors/*` builder sets `InspectorContent.reading`, one computed sentence drawn first; `holder-reading.ts`), the internal selection kinds `sector` and `compare` (resolved from `?sector=` and `?funds=`, never read from `sel`), `components/ownership/show-all.tsx` (an institution page list's rows past the tenth), the logos (`stock-logo-box.tsx` over `CompanyLogo`, `holder-logo.tsx` the favicon of the registry's website with a monogram fallback, `sector-icon.tsx` the landing page's `/assets/sectors-v2` images via `lib/sector-images.ts`). Funds: `components/ownership/funds/` (`fund-portfolio-map.tsx` a treemap whose cells select `holding:`, `fund-exposure-map.tsx` six sectors plus Other, `fund-changes-table.tsx` two snapshots compared, `expandable-row.tsx` the in-row chevron; its compare tray is `SelectionTray`) over `ListFunds`, `GetFundPortfolio`, `CompareFundSnapshots` (`ownership_funds.go`) and `app/actions/ownershipFunds.ts`; `fundHref(key)` / `fundLabel` in `lib/ownership/kinds.ts`, which also holds `shortSector` (the short sector names every instrument prints, the full name in the title). Holders: `components/ownership/holders/` (`holder-browser.tsx` the twenty largest with Show all, `holder-connections-map.tsx` the tree, `holder-tree.ts`) over `app/actions/ownershipHolders.ts`. Vendored Gamma components live in `components/gamma/` with `gamma-bridge.css` mapping their tokens onto the house theme (standard ease only, no spring; the data table transitions colour and opacity, never width) |
| Web | `app/ownership/` (the hub, `[slug]`, `stocks/[code]`, and the static ISR pages `notices/` and `stocks/`), `components/ownership/` (server components; the islands are `ownership-tables.tsx`, `notice-feed-explorer.tsx` and `registers-explorer.tsx`: the action as a prop, `useSearchParams` under their own Suspense, `history.replaceState`, no Connect; `notice-mark.tsx`, `notice-week-bars.tsx`, `register-rows-table.tsx` are the parts they draw), `app/actions/ownershipExplorer.ts` ("use server"; the one loader a page and its island share; KV only for each page's DEFAULT view), `lib/ownership/query.ts` (the clamps and the URL codec) and `events.ts` (reads `notice.event`, never re-derives it), `components/stocks/register-strip.tsx` (props only), `lib/ownership/` (`trace.ts` the lane geometry, `kinds.ts`, `rows.ts`, `age.ts`, `register-indexability.ts`), `app/actions/getOwnership.ts` (ISR tag `ownership` + KV last-good under the `v2` keys, flush `ownership`), `app/actions/getStockRegisterStrip.ts` (the Overview's read: `unstable_cache`, a 4 s abort, no KV, tagged by stock and never `ownership`) |
| Guards | `app/ownership/__tests__/isr-source-safety.test.ts` (no `searchParams`, `cookies()`, `headers()`, `auth()` or `useSearchParams` under `app/ownership`), `app/__tests__/editorial-copy.test.ts` (no em dash, "of the voting power", "index ETF", "sold" in ownership copy), `scripts/route-kinds.mjs` `OWNERSHIP_ROUTES` (the two dynamic routes) and `OWNERSHIP_STATIC_ROUTES` (the hub, the feed, the registers list: each must keep a positive `initialRevalidateSeconds`), `components/ownership/__tests__/client-boundary.test.ts`, `app/api/static-pages/warm-cache/__tests__/budget.test.ts` (23 shell pages read eight at a time fit the 145 s the callers allow) |
| MCP | `get_stock_ownership` (holders, by-kind sum, the 15 largest fund holdings, each fund named with its institution) and `get_institution_holdings` (slug or name; an ambiguous name lists the slugs), `services/shorts/internal/mcp/tools_ownership.go`. A stated 0.00% fund weight beside a real value is omitted (super disclosures state two places) |

### Landmines

- **A workspace page is ISR, and its shell is in three lists.** Every page
  under `app/ownership/` exports `revalidate` and reads no `searchParams`;
  the selection, the window and the sorts live in `?sel=` and the desk
  params read by islands under their own Suspense (`history.replaceState`).
  A new page goes into `OWNERSHIP_STATIC_ROUTES` (`scripts/route-kinds.mjs`),
  `src/config/isr-shell-pages.json` (the warm sweep) and
  `lib/seo/sitemap-sections.ts`, or it is served cold after every deploy.
- **The island's placeholder is the toolbar's height.** A server-rendered
  toolbar row is one row from `sm` (`TOOLBAR_ROW_CLASS`); an island that
  mounts a taller control shifts the drawing. Measured at 1440 on
  2026-11-04: the map's row fits its 1016 px column with about 30 px to
  spare, so a longer option label wraps it (the Sort control cost the Colour
  option its "Index" word: "Fund shares"). Window is a select, never four
  chips, everywhere: the instrument pages, the notices feed and the Overview
  (whose row is the search, a Source select and the Window select).
- **Every drawn element selects, through the same `?sel=`.** A map cell, a
  sankey band, a heatmap cell, a fund treemap cell, a holder, a change row:
  each writes the selection and the rail reads it. The folded "Other
  sectors" band opens the tail instead. A heatmap cell is reached by
  keyboard through the sr-only table, whose Select buttons show when
  focused.
- **A connection the register refuses is empty, not down.** The register
  names its own industries; a band drawn from fund holdings can name a
  sector with no notice in it, and `ListStockRegisters` answers
  `invalid_argument`. `loadConnectionCompanies` reads that as zero companies
  (logged), so the rail shows a real zero; only a transport failure is an
  outage.
- **The fund page decodes its segment** (`asx%3AVAS` and `asx:VAS` are one
  key) and a fund the record does not hold draws its own not-found card
  inside the workspace; `notFound()` is for an empty or malformed segment.
- **Fundamentals of the house rules still bind here**: n/a never 0 (the
  Overview's coverage tile prints n/a without an overview), kinds and
  sectors are never market red or green, the one coloured figure in a rail
  is a change's whole signed figure.
- **A notice is withheld rather than guessed** (scans, annexure-only figures,
  a headline naming a company not on record, votes that do not fit ASIC's
  share count as at the notice's date). The overview reports read and
  withheld counts; never estimate a withheld figure.
- **Notices overlap.** MUFG files for First Sentier and Morgan Stanley, a bank
  files for its fund manager, CBA and KKR both file for Colonial First State.
  `countedHoldings` counts a registry `Group` once and identical (voting power,
  date) pairs once; other overlaps remain, so every sum is "what the notices
  disclose", never a share of the company. Say so wherever a sum is shown.
- **Kinds are colours of a category, never market red or green**
  (`kinds.ts`). A headline figure, a bar's figure or a sum prints to two
  decimals (`formatHeadlinePct`, `formatSum`); a single notice's figure keeps
  the precision it states (`formatVotingPower`) only in a list of notices and
  the register's own row.
- **A super fund's holdings disclosure is one investment option**, not the
  whole fund; ETF issuers are linked by the manager before the slash in ASX's
  issuer field ("Milford / EQT" is Equity Trustees the RE, not EQT the firm).
- **"Current" means the newest notice we could read**, not held today: a
  withheld 605 or a cessation filed under another holder key leaves a stale
  row (about a quarter of current holdings are over 12 months old). Every
  holding row carries its notice date and an age cue past 90 days
  (`lib/ownership/age.ts`); an empty register reads "no notice read", never
  "no holder".
- **A sum is never drawn against a 100% company track.** `DisclosedBar`'s full
  width is the disclosed sum, printed beside it; `KindBar` (a 0-100% track
  rescaled past 100 without saying so) was deleted. Counts and sums share one
  basis: "interests" is `sum(by_kind.holders)`, the deduplicated count, while
  `OwnershipStock.holders` counts rows.
- **Only per-holder history is drawn.** The Holder Lanes (`lib/ownership/trace.ts`)
  step one holder at a time from notice to notice, on a per-lane scale from the
  5% threshold up; a cessation ends at the 5% edge ("under 5%", never zero) and
  a dotted tail is the time since the last notice read. A stock-wide or by-kind
  history would reconstruct past registers from a record with withheld notices,
  split keys and the 100-notice cap, which is guessing. Server SVG, no visx, no
  client JS; kinds never colour a lane (`hedge_fund` is the short-interest
  series colour) and kinds and short interest never share one figure.
- **"Crowded" counts investors only.** `institutionalKinds` excludes
  `bank_broker`: ATH's 58% "crowded" register was 74% a lending desk. Banks and
  brokers stay in the register sums and the lending view; their notices are
  "often" securities lending, one word, everywhere.
- **"Withheld" is eight outcomes, reported apart.** The overview carries
  `withheld_by_outcome`; `not_a_notice` and `fetch_error` are never "unread".
  `GetStockOwnership.withheld_listed` is "listed under" the code (a notice
  under several codes is counted under one) and is never printed beside a sum.
  `history_total` says when the 100-notice `history` is capped.
- **Every figure carries its own date.** `short_as_of`, `index_as_at_from/to`
  and `index_files`, `latest_notice_date`, `OwnershipSource.as_at_from`; AUM is
  dated by `aum_as_at`, which was NULL until `parseAPRADate` learned Excel's
  format 14 (the next funds run writes it). Never one page-level "as at".
- **New rpc cost.** A field on an existing response needs only `ownership.proto`
  and `make openapi`; a NEW rpc needs the `shorts.proto` mirror (the parity test
  runs on pull requests). Per-query cache keys on the old loader cost 8-9 pool
  acquisitions each; every handler now reads the universe, and a list or feed
  filters it in memory or runs its own one-statement indexed query. The web KV
  keys are versioned (`cache:ownership:*:v2`): a new field read from an old
  entry is silently 0/false for up to 21,600 s otherwise.
- **The strip's read is outside the Overview's critical path** and reads no
  KV: the daily sync's layout expiry refreshes it, and the job's `ownership`
  ping must not add a regeneration wave to the most-visited tab.
- **Activity exists only on a first page.** `ListSubstantialNotices` computes
  the weekly counts for windows of at most 90 days and only when `cursor` is
  empty; the loader asks for it only there (`wantsActivity`), so a load-more
  never reads `activityOk` false. The first page is the only cached read
  (`ListSubstantialNoticesKey`, TTL the universe's remaining life); a cursor page
  is read through.
- **The API names no start date.** Window 0 is every notice read; the record's
  first day is not a fact the API states, so `feed.empty.all` says "No notices
  read match these filters." and nothing more.
- **The registry reaches the feed island only when it is whole.** The notices
  page passes `ListInstitutions` to the holder select only when
  `total <= institutions.length`; otherwise the API validates a `?holder=`
  slug. An unlisted slug from a link is kept as an option labelled by its
  slug; a slug the registry does not hold is refused by the API and drawn as
  the outage, never silently another view.
- **"All notices" links carry `window=all` and `rel="nofollow"`** and are
  drawn only when the page has a notice to show (`history_total > 0`, an
  institution's count > 0): over 1,100 filtered URLs each serving the default
  view's HTML otherwise. The hub's bare `/ownership/notices` link is followable.
- **The register list has three grammars switched on the TABLE's width**
  (a container query at 980 and 1,320 px, because the signed-in rail takes
  288 px of the viewport): two rows per stock below 980, seven columns with the
  name and industry under the code from 980, eleven from 1,320; every value is
  rendered once, every `<time>` is `whitespace-nowrap`. The feed stacks below
  `md`. Measured on static markup to fit 360 to 1280 px signed in; no e2e holds
  it yet (stage 3).
- **Dates bound the feed on their own.** When `since` or `until` is named on
  `ListSubstantialNotices` the window is ignored, the span is capped at 366
  days and `until` before `since` is refused; the heatmap's cell links depend
  on it (they carry dates and no window). The feed reads `industry`, `since`
  and `until` from its link.
- **The desk is one state.** `desk-state.ts` holds window, lens, sector, the
  brushed `since`/`until` and the fund window's `from`/`to`; every island writes
  through it, so no island's write erases another's. While a brush or the date
  slider is held nothing moves but its handles.
- **The stock panel never prints the short position** (sections 11, 12 and
  13.8: kinds and short interest never share a panel); it links the Short
  interest tab. The map's short lens is the one place the chart's short colour
  is used; a notice flow is drawn ink/paper/amber, never red or green.
- **Exposure is an estimate**: voting power x market cap, labelled "disclosed
  exposure, estimated" wherever it is drawn; a stock without a market cap has
  none (has_ false, never 0), and in the map its area is the universe's median,
  flagged in its title.
- **A screen-reader table takes the house wrapper** (`ScreenReaderTable`):
  `sr-only` on a `<table>` does not constrain a display:table box, and the
  map's own sr-only table made the hub scroll sideways to 801 px on a phone.
- **The hub's first-load JS grew from 127 to 179 kB** with the four
  instruments (the budget is 300 kB; the baseline carries it). A new
  instrument must earn its chunk: the layouts are pure and run on the server.
- **Unclassified holders (59% of positions) are plain text**: no holder pages,
  no holder search, no fuzzy merging across keys (`name:` keys split on text
  layer breaks: "Limite d"). The parser withholds placeholder names ("SEE
  ANNEXURE 1") as `no_holder` unless the name resolves to a curated
  institution; `-mode repair-placeholders` removes rows stored before the gate.

- **A lens is five stops, told apart and legible.** Every bin is a theme
  token (`globals.css`), the figure printed on it an ink token of its own, at
  4.5:1 or better and at least 7 L* from its neighbours in both themes;
  `desk-ramp-contrast.test.ts` reads the CSS and fails on a stop that is not.
  Never mix a colour in `desk-scales.ts` again (five mixes of amber over a
  near-black paper were five browns). Light's top bin is one step deeper than
  Burnt Amber for that reason.
- **The rail leads with a computed sentence, never model prose.** Every
  `InspectorContent.reading` is built clause by clause from figures the rail
  already shows; a missing figure drops its clause, so no reading can print
  n/a or 0. The holder rail's comes from `holderInspectorContent` (the holder
  pages never go through `loadInspector`).
- **The hub's panes are fixed-height and have no control row.** 420px for
  the map and the sankey, 320px for the heatmap (the count measure, the
  eleven most active sectors plus a fold, ranked by magnitude under the
  "changed" default) and the index fund positions (five rises beside five
  falls); the compact heatmap once drew the net-change measure, whose scale a
  few bad notices blew out to 200 pp so every cell was the paper. Measured
  2,129px at 1440 (4,401 at the review).
- **The phone map's minimum cell is 32 units** (`PHONE_MIN_CELL`): at 44 the
  live market drew three sectors and folded twenty-three. A sector's figure
  there is the market-cap-weighted mean of its stocks' figures, said in the
  cell's title and one caption; the fold cell names its three largest
  members and its chips sit in a details beneath.
- **The institution page shows ten rows per list** (`SECTION_ROWS_SHOWN`),
  the rest behind "Show all N" in the HTML: measured 5,413px at 1440, of
  which the holder's connections tree is 1,750. The backlog's 3,000px could
  not be reached with any number of rows; the figure is the record.
- **The parser cuts labels and refuses sentences.** A trailing "Name" label
  and a leading "This notice is given by" are cut off a holder name; a name
  still carrying a form phrase is withheld (`no_holder`); a 604 whose stated
  change is over 50 points is withheld unless both figures sit on one layout
  line of the voting-power section (`pairOnOneRow`). `-mode
  repair-placeholders` lists and removes the stored rows the rules refuse
  (`storedNotice.PreviousPct`); the production repair is a hand run.
- **Kind colours are on a leash** (`kinds.ts`, `kind-chroma.test.ts` reads
  the swatches): every kind is a light and dark hex pair, HSL chroma at or
  under 0.45 and under the amber's minus 0.1, outside the amber's hue band
  unless at or under 0.30, the dark pairs at least CIE76 9 apart; the active
  manager is a mustard, never the amber; the sankey's holder body is the
  foreground (muted for Unclassified) with the kind as a 4-unit edge
  (`kindEdgeClass`, `KindInfo.fill`), so the amber selection is the only
  bright mark.
- **The toolbar fold's first paint is closed on a phone.** `view-disclosure.tsx`
  renders `open` for the desktop's scriptless first paint, and `view-fold`
  (globals.css) hides the content below `sm` until the effect has set the
  attribute from the `sm` media query and marked the element ready; the
  effect follows the query, so a phone turned to landscape gets its controls
  back. The hub's plate lives inside that fold (DeskToolbar's `plate` prop,
  one plate in the DOM) and the band, the records and the method order after
  the panes below lg (`order-[10|11|12] lg:order-none`), so the map is the
  phone's first screen.
- **A comparison is the two keys in `?funds=`** (the checkboxes' cap is two,
  a third tick replaces the oldest): the rail resolves an internal "compare"
  selection (precedence `sel`, then the comparison, then the zoomed sector;
  "Clear selection" removes `funds` only; no bottom sheet below lg, as for
  the sector zoom; no trail step); a sector a complete file does not name is
  a true 0.00% in the diff and in the fund exposure map's cells, n/a only for
  a file with no holdings.
- **Company names are served clean.** Every name an ownership rpc serves goes
  through `cleanCompanyName` (`servedOwnershipName` in the store): BHP, CSL,
  NAB, ANZ, QBE, AMP, IAG, CBA, WBC, S32, REA and ASX stay capitals in any
  source, a shouted short English word ("RED") reads as a word; the stocklist
  copy and `web/src/@/lib/company-name.ts` carry the same tables.

### Insights explorer (folded into the desk, spec 14.10)

- The insights explorer folded into the desk: the market map and money flow are `/ownership/map` (Size "Index fund holdings", the `index_flow` lens), the heatmap and window are `/ownership/activity`, "Largest moves" is the Activity rail, and the connection rail names its holders.
- `/ownership/insights` answers 308 to the mapped desk link (`app/ownership/insights/route.ts`, built by `lib/ownership/insights-redirect.ts`); a bare request goes to `/ownership/map?lens=index_flow`.
- `OwnershipInsightsService` was removed: it was public for one day and nothing else called it, so the desk reads `OwnershipService` only.
- Spec: `docs/superpowers/specs/2026-11-02-ownership-explorer-design.md` 14.10.

## Weekly/Monthly/Yearly Reports

LLM-generated short-selling reports at `/reports` (weekly `2026-W23`, monthly `2026-05`, yearly `2025` — one `weekly_reports` table, slug shape disambiguates).

- **Generator**: `services/weekly-report-generator/` (Cloud Run job + Fri/monthly schedulers, `terraform/modules/weekly-report-generator/`) — snapshot (movers/z-scores/streaks/industry breakdown) → two-pass multi-model synthesis (`prompts.go`) → quality gate → JSONB upsert
- **Read path**: `services/shorts/.../weekly_report.go` (`GetWeeklyReport`) + `list_reports.go` (`ListReports`); logos hydrated at READ time, never stored
- **Frontend**: `web/src/app/actions/reports/getReportData.ts` → `web/src/app/reports/`
- **CRITICAL contract**: generator struct json tags must exactly match proto snake_case field names (the API `json.Unmarshal`s JSONB straight into proto structs) — enforced by `json_contract_test.go`; any proto field addition needs a matching generator tag + `buf generate`

Operating manual (running, prompt iteration via `-print-prompt`/`-dry-run`, quality gates, landmines): use `$weekly-reports` skill (`.claude/skills/weekly-reports/SKILL.md`); service readme at `services/weekly-report-generator/README.md`.

## Housing (tracker + suburb explorer + listings crawl + price-drops)

Five products over one fact/dimension data model, one chart system and one
Connect-RPC service (`HousingService`, `housing.proto`, 17 rpcs): the
**Widow-Maker editorial feature** (`/features/the-widow-maker`, baked arrays), the
**House Prices Tracker** (`/housing`, live ABS/RBA/Valuer-General ingest), the
**suburb explorer** (`/housing` → `/housing/[state]` → `/housing/[state]/[suburb]`
choropleth drilldown, "Colour by" price / Census / electoral / gated crime /
terrain / hazard shares, plus toggleable flood-planning, observed-water and
bushfire **overlays** synced to `?metric=`/`?overlays=`), the
**residential listings crawl** (REA/Domain via warm host-Chrome CDP on residential
Macs, plus a property.com.au AVM tier), and the **price-drops board**
(`/price-drops`), plus the **council hub** — `/housing/[state]/council` + `/housing/[state]/council/[slug]` (`ListCouncils`/`GetCouncilProfile`, map council level + borders; `architecture.md` §11; built 2026-09-24, awaiting its 000126 prod DDL + deploy). **The five products are LIVE on prod** — as at 2026-08-09: 88,689 crawl listings
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
| `docs/feature/housing/pipeline.md` | The 38 collector modes, the 16 official jobs, run order, timeouts, exit-code contract |
| `docs/feature/housing/operations.md` | Runbook: prod DDL, rig crawl recovery, revalidation, takedown, credentials |
| `docs/feature/housing/architecture.md` | Decision/incident record + extension recipes — read before touching crawl classification or caching |

### Landmines

- **The prod deploy does NOT run `migrate up`** — it applies a hardcoded allowlist that contains **zero housing migrations**. Apply housing DDL BY HAND (`task db:prod:apply FILE=… CONFIRM=prod`: session pooler **5432**, one transaction with `SET LOCAL statement_timeout = 0`; `PGOPTIONS` does nothing, Supavisor drops it) *before* merging code that reads the new columns, or every housing read path 500s. Prod `schema_migrations` lies (force-written to 75).
- **MV refresh needs that same session pooler.** Run `refresh_housing_materialized_views()` via `task db:prod:refresh WHICH=housing CONFIRM=prod` (5432, `SET LOCAL statement_timeout = 0`, exits 1 if a view was skipped); the txn pooler (6543) kills it mid-`REFRESH … CONCURRENTLY`. The starvation hazard this used to warn about — an `EXCEPTION WHEN OTHERS` guard that does not catch the `query_canceled` a statement timeout raises, so one timed-out MV starves every MV after it — **is fixed**: `000107_harden_housing_mv_refresh` landed and prod's function handles `query_canceled` (verified against `pg_proc`, 2026-08-28). The pooler rule still stands, and the collector already issues `SET LOCAL statement_timeout = 0` before the call.
- **000139's suburb reference views are the exception to DDL-first.** The API tolerates their absence (42P01 fallback), but only a collector built with them calls `refresh_suburb_reference_views()`, so apply 000139 only after the Cloud Run job and the rig binary both carry that call (the check is its `PROD_APPLIED.md` row), or the suburb list, profile, similar suburbs and council table freeze at the apply date while every run reports success. After a hand fix to `house_prices`, `suburb_demographics` or `suburb_amenities`, refresh them too: `task db:prod:refresh WHICH=suburbs CONFIRM=prod`.
- **Charts can't SSR, and functions can't cross the RSC boundary.** Every interactive chart is imported `dynamic(..., { ssr: false })` from a `"use client"` module; pass a **serializable key** (`format="aud"|"percent"|"index"`, `MetricKey` from `highlight-metrics.ts`) and look the formatter/colour scale up client-side — never pass a formatter or scale as a prop from a server page.
- **Reading `searchParams` in a server page silently forces dynamic rendering** even with `revalidate` exported, killing the ISR that serves `/price-drops` in 40–58ms. Read `?state=` client-side via `useSearchParams` under a real `<Suspense>` boundary (the `next/dynamic` fallback does not satisfy it).
- **ABS WAF**: `abs.go` MUST send `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)` + `Accept: application/vnd.sdmx.data+csv;labels=both` — a bare request 403s. Conversely, don't hand-set a UA on the crawl tier; `stealthhttp`'s native engine supplies browser-realistic TLS/headers.
- **Crawl rows are never republished raw.** REA/Domain/property.com.au rows carry `source_licence='proprietary-tos-restricted'` (a column DEFAULT, so the unlicensed state is unstorable); only derived aggregates are a publishable surface, only counts-only summaries cross to brandbrain, and `CRAWL_TRACE` artifacts stay local + gitignored. Kill switches: `HOUSING_DROP_LISTINGS_ENABLED` / `HOUSING_VALUATIONS_ENABLED` (both ON by default).
- **A hand-run crawl writes nothing.** `CRAWL_DRY_RUN` / `CRIME_DRY_RUN` / `PURGE_DRY_RUN` default to true in code; only the launchd wrappers export `false`. Check `dryRun=` in the startup log before believing a run persisted.
- **Crawl throughput and its alarm are ONE decision.** `CRAWL_DELTA_MAX_SUBURBS` (now **120**) is the ceiling of the whole crawl — 500 suburbs ÷ cap = the rotation — and `CRAWL_FRESHNESS_ALARM_HOURS` (now **120h**) must match it. The old 60/72h pairing implied an 8.3-day rotation against a 3-day alarm, so the alarm fired on the designed steady state and stopped meaning anything (measured 2026-08-18: median 117h, oldest 305h). Change one, change the other. **Reaching that throughput is a third thing, and it was broken:** a re-warm (exit 3) used to end the run and hand the rest back to the *schedule*, which fires at 10:00 daily — so one routine Kasada re-warm cost a whole day. Measured 2026-09-10: 21 of 38 jobs against a 120 cap, the ~4-day rotation stretched to weeks, 502 suburbs past the alarm. `hc_drain_until_empty` now cools down and retries in the same run (`CRAWL_REWARM_COOLDOWN_SEC` 900, `CRAWL_REWARM_MAX_RETRIES` 2, `0` disables), still returning 3 once the budget is spent so the exit contract and the alarm keep their meaning. It raises no ceiling — it makes the rig reach the one already set. **Judge a run by SUCCEEDED jobs, never by "processed"** — processed counts jobs claimed and immediately DEFERRED because the portal circuit was open, so a long run of deferrals reads as throughput. Measured 2026-09-11: budget 2 gave 85 processed / **34 succeeded** / 35 deferred and cleared 38 stale suburbs; budget 4 gave 323 processed / **26 succeeded** / 241 deferred / 56 failed and cleared 19. More retries against an open circuit is just asking a blocking portal again.
- **Alerting: the sentinel is the only layer that survives a dead rig.** `.github/workflows/housing-freshness.yml` (daily, GitHub-hosted — never the rig's self-hosted runners, which die with the rig — read-only, files one GitHub issue) checks MV refresh age (72h), per-suburb `CATALOG_STALENESS` (132h) + `RIG_STATUS` alongside global `EVENT_SILENCE` — the global check alone stayed **green through a two-day outage**. Rig-side, every terminal wrapper failure pushes via `hc_alert` (notification + `CRAWL_ALERT_WEBHOOK`, falling back to `CRAWL_FRESHNESS_WEBHOOK`); unset webhook = notification only.
- **The rig is a hand deploy and has drifted before** (binary 4h17m behind the fix it was assumed to carry). Use `deploy/stage-rig.sh` (`--check` is read-only — run it FIRST in any crawl incident); wrappers log `vcs.revision` at run start. The Playwright driver now lives at `CRAWL_PW_DRIVER_DIR` (`~/.shorted-housing-crawl/pw-driver`), **not** `~/Library/Caches` where a sweep deleted it; repair with `-mode install-driver`.

## Economy (map explorer + state pages + series platform)

`/economy` (map-first hub, ISR) → `/economy/[state]` (SSG ×8, banner heroes with
centered state silhouettes, breadcrumbs) over a **generic economic-series
layer**: `economic_series` + `economic_observations` (migrations
000081/000082/000083/000085) fed by `shorted economy` (`services/jobs/internal/jobs/economy`)
(**11 sources**: rba, cpi, labour, trade, gdp=SFD, petroleum, govfin+detail,
approvals, retail, population, markets-derived) on a monthly Cloud Run Job,
read by the public **`EconomyService`** (economy.proto after the proto split):
`ListEconomicSeries`/`GetEconomicSeries` + `ListStateCompanies`/
`GetStateCompanyAggregates` (operations-weighted company↔state exposure).
472 series / ~120k observations. **LIVE on prod.**

### Key files

| File | Purpose |
|------|---------|
| `services/jobs/internal/jobs/economy/` | All importers (`shorted economy -mode all`); probe-pinned constants; fail-closed filters |
| `services/pkg/absdata/` | Shared ABS SDMX-CSV + RBA CSV clients (WAF-safe UA is mandatory) |
| `services/migrations/000081…000085` | Series layer, registry kind/method extensions, state_exposure + MV |
| `services/shorts/.../economy.go`, `state_exposure.go` | RPC handlers (normalized cache keys) |
| `services/enrichment-processor --backfill-state-exposure` | LLM operations-weighted state footprints (top 300 = 93.8% mkt cap) |
| `web/src/@/lib/economy/map-metrics.ts` | Serializable "Colour by" registry (kind:"series" \| "aggregate") — availability + metrics single source of truth |
| `web/src/@/components/economy/` | Map explorer, state charts/companies/correlations, dual-axis chart, `<EconomyIcon>` sprite |
| `web/src/app/economy/` + `[state]/` | Hub + state pages; actions in `app/actions/getEconomy.ts` (KV last-good layer) |
| `web/scripts/economy-icons/` | Icon-set generation pipeline (housing-icons clone) |
| `terraform/environments/prod/main.tf` `module "shorted_job_economy"` | Cloud Run Job `shorted-economy` + monthly scheduler (5th, 17:00 UTC) |

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
- **Prod MV refresh**: `task db:prod:refresh CONFIRM=prod` (session pooler 5432,
  `SET LOCAL statement_timeout = 0`; the txn pooler kills
  `refresh_all_materialized_views`).
- First collector run in a new env is manual: `gcloud run jobs execute shorted-economy`.

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
  allowlist. Apply new migrations BY HAND (`task db:prod:apply`: session pooler
  5432, `SET LOCAL statement_timeout = 0`) BEFORE merging, or the API ships selecting columns prod
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
- **A new House `source_url` is a SUCCESSION, never a fresh member.** APH moved
  the 48th Parliament register onto `interests-register-api-public.aph.gov.au`
  (2026-09: 147/151 rows) and edited 9 name keys in the move (Chalmers James→Jim,
  Pasin Antony→Tony, Brynes→Byrnes…). `register-discover` links old→new
  (`superseded_by`, migration 000123 — in the deploy allowlist, applied before
  the image swap) and `register-load` carries the predecessor's person; resolving
  the new row by name mints duplicates. The crawl is incremental (re-queue when the listing
  date ≥ fetch date). Runbook: operations.md "Re-crawling prod".

## MCP server — OAuth 2.1, 32 tools, protocol `2026-07-28`

`https://api.shorted.com.au/mcp` — read-only Model Context Protocol access to
everything above: short positions, stocks, housing, economy, the register of
interests, ownership. **LIVE on prod**, streamable HTTP, 32 read-only data tools, 3 resources,
3 prompts. Plus six alert tools (`list_my_alerts`, `create_alert`, `pause_alert`, `resume_alert`,
`delete_alert`, `list_my_alert_history`) for the signed-in user's own alerts, served ONLY to a
token carrying `alerts:write` (`services/shorts/internal/mcp/alerts_write.go`,
`HandlerWithAlerts`). The one write scope, and the one exception to the read-only rule below.
Anonymous and unscoped callers also see ONE discovery tool, `manage_my_alerts`
(`alerts_discovery.go`), which does nothing itself: calling it returns the sign-in challenge
(401 `resource_metadata` + `scope="alerts:write"` for an anonymous caller; 403
`insufficient_scope` for a signed-in caller without the scope), before any tool runs. Scoped
callers do not see it. The challenge is a status code, not a tool result, because a client starts
its OAuth flow on the status.
Go SDK (`modelcontextprotocol/go-sdk`), served by the shorts API.

**The product promise, and the constraint every change here answers to:** a user
adds the URL to Claude or ChatGPT and the client does the rest — challenge,
discovery, registration, browser consent, callback, token, tools. Nothing
hand-configured. **Anonymous access must keep working**: OAuth *raises* limits
and identifies a caller, it is never a gate on first contact, and no tool is
reserved for a paid plan.

The Go API is BOTH the resource server and the authorization server, on purpose:
access tokens are HS256 with a symmetric secret, so splitting mint and verify
across two platforms would mean sharing that secret and rotating it twice.
Next.js contributes only the consent screen.

### Key files

| File | Purpose |
|------|---------|
| `services/shorts/internal/mcp/` | Server, registry, 32 tools, catalog, resources, prompts |
| `services/shorts/internal/mcp/auth.go` | Audience-bound verification, RFC 9728 metadata, `OptionalBearerToken` |
| `services/shorts/internal/mcp/ratelimit.go` | Per-tool-call cost, identity, JSON-RPC 429 |
| `services/shorts/internal/oauth/` | AS metadata, consent tickets, grant, token, CIMD + DCR |
| `services/pkg/ratelimit/http.go` | `HTTPMiddleware` — the same limiter, over plain HTTP handlers |
| `web/src/app/oauth/authorize/` | Consent screen (page + client component + server actions) |
| `services/migrations/000116_*` | `oauth_clients`, `oauth_consent_tickets`, `oauth_authorization_codes`, `oauth_refresh_tokens` |
| `web/public/docs/mcp-markdown.md` | The connection guide served at `/docs/mcp.md` |

### The rules that shape every change here

- **A grant needs a CONSENT TICKET, not just an identity.** The grant was once
  authenticated by a Firebase ID token alone — that proves someone holds a
  credential, not that a human approved anything, and with open dynamic
  registration it was exploitable end to end. Tickets are mintable ONLY via
  `POST /oauth/consent/ticket` behind `INTERNAL_SERVICE_SECRET`, so minting
  needs a server-held secret an attacker with a stolen credential does not have.
  Single-use, ~2 min, hashed, bound to user + client + redirect URI + PKCE
  challenge + resource + scope — **all six re-checked by the grant**.
- **Do not require a Firebase ID token in the browser.** next-auth's cookie
  lives 30 days and the Firebase client session does not, so a properly
  signed-in user often cannot produce one. Requiring it fails real users,
  silently and only for some of them. It is an optional cross-check.
- **Tier is not a scope.** Every scope is read-only except `alerts:write`, which
  is the one write scope and names the signed-in user's own alerts, not a plan. Every
  other scope names a data domain
  (`shorts:read`, `housing:read`, `economy:read`, `politics:read`). Expressing a
  plan as a scope would send a paying customer through a pointless
  re-authorisation to fix a quota problem.
- **Never publish a ceiling you do not enforce.** The catalog reports
  `authentication.rateLimits.enforced` read from the RUNNING config, and derives
  the numbers from `ratelimit.DefaultConfig` rather than restating them. #455 was
  three published rows over-promising against the code; this is the same defect
  in the other direction.
- **Loopback redirect URIs ignore the PORT (RFC 8252 §7.3), and nothing else.**
  A desktop client registers `127.0.0.1:51763` and listens on a different
  ephemeral port next time, because binding a fixed port is what would be
  insecure. Host, scheme, path, query and fragment stay exact-match.

### Landmines

- **Anonymous access is never challenged, and that is the adoption path.** MCP
  auth is challenge-driven: a client learns OAuth exists from a `401` carrying
  `WWW-Authenticate`. First contact must stay free, so the ONLY place we
  challenge is the ceiling — an anonymous caller who exhausts their quota gets a
  **401** (not a 429) with the RFC 9728 challenge, because clients branch on the
  status and a 429 is a transport failure to all of them. An *authenticated*
  caller at their ceiling gets a plain 429: they have already done what a
  challenge asks, and what they need is `upgrade_url`. Do NOT "fix" adoption by
  gating anonymous access. (Before this, OAuth was live but fully dormant —
  measured 2026-08-30, a real client connected, got 24 tools (32 today), stored no auth
  state and never started the flow.)
- **`RATE_LIMIT_ENABLED` is now TRUE in prod (Terraform, `shorts-api` module).**
  It was off everywhere until the app layer could tell our own traffic apart:
  the Connect interceptor buckets unauthenticated callers as `ip:<address>` at
  the anonymous tier, and Vercel SSR arrives from a handful of shared egress IPs
  with no token. The **`first-party` / `first-party-unverified` tiers**
  (`interceptor.go` `classifyFirstParty`) are that class, keyed `first-party:<ip>`
  and matched on the SAME user-agent marker + secret header the edge worker uses
  — change one layer's marker and you must change the other. **Both classes are
  per-minute UNLIMITED**: this class carries our own SSR *and* every anonymous
  browser RPC (middleware stamps the marker on rewrite-proxied paths), so a
  rejection here does not throttle one caller — it fails every reader behind
  that shared egress address at the same instant. The edge's first-party bucket
  (600/10s) is the ceiling for it, and the 200k monthly meter on the
  *unverified* class is what makes copying the marker worthless. The secret
  therefore decides only the MONTHLY ceiling, so a rotation gap or an unreadable
  env var costs a meter, never a 429 on our own site. That asymmetry
  is deliberate; the edge learned it the expensive way (7,045 self-inflicted
  429s when CI's prerender could not read the sensitive var).
- **Resolving WHO a caller is takes THREE layers, and any one alone does
  nothing.** `buildPublicEdgeReadHeaders` (synthesized `/edge/v1/*` requests must
  copy the address AND the bypass secret forward — a marker without its proof is
  `first-party-unverified`), `filterRequestHeaders` (strip client-supplied hops
  first, then re-add Cloudflare's own `cf-connecting-ip`), and `resolveClientIP`
  (believe those headers only when the rightmost forwarded hop is a published
  Cloudflare address, because Cloud Run is publicly reachable). Symptom when it
  breaks: every identifier in `api_usage_monthly` is a Cloudflare address and
  callers behind a colo share one bucket. Measured 2026-08-30/31 — **two
  consecutive fixes deployed cleanly and changed nothing**, each blocked by a
  different layer. A deploy succeeding proves nothing here: snapshot
  `api_usage_monthly`, wait a flush cycle, diff, and classify what grew.
- **Ordinary browsing carries NO auth token** (no auth interceptor on
  `client-api.ts`'s transport), so page views land in `first-party`, not on a
  user identity. The published free browser cap is therefore **not reachable by
  browsing** — only authenticated feature calls touch it. Corollary: a reader
  cannot be rejected by the app layer at all, so browser 429s are the edge or the
  zone rule.
- **The `/oauth/` routes render WITHOUT the site header and footer**, and the
  success screen's `min-h-screen` depends on that. Chrome is dropped in
  `conditional-header.tsx` / `conditional-footer.tsx` (the same mechanism embed
  and roadmap use) because a nav bar beside a consent decision invites people to
  wander off mid-authorisation. Put chrome back and the approval screen exceeds
  the viewport, the page scrolls, and on a phone the artwork is clipped out of
  sight before anyone sees it. `conditional-chrome.test.tsx` pins the routing;
  the height coupling is a comment, not a test.
- **Approving holds the browser for ~1.5s before redirecting.** Without the
  pause the navigation fires within a frame and the confirmation is never seen,
  which is exactly when people wonder whether it worked. It is not latency to
  trim.
- **`Stateless: true` on the streamable handler is load-bearing.** Without it the
  SDK silently negotiates *down* to legacy `initialize`, and an in-memory
  transport cannot detect it. Any test for protocol behaviour must drive a real
  socket.
- **Not every MCP request is a call — some are streams, and the platform will
  end them for you if you do not.** A `subscriptions/listen` POST (SEP-2575) has
  no synchronous result: the SDK acknowledges the subscription and blocks.
  **There are TWO ceilings on that, at different times, costing different
  things** — Cloudflare's **120s** proxy read timeout is what the CLIENT sees (a
  stream that sends no bytes for 120s earns a 524), and Cloud Run's **300s** is
  what WE pay (the request slot stays occupied). Measured 2026-09-10: all 53 API
  POST 5xx in 24h were `/mcp`, every one with an origin latency of 299.98s
  reported at the edge as 524, from a perfectly healthy client — the edge bailing
  early while the origin held on. **A first fix at 240s cleared only the second
  ceiling; a prod probe still returned `524 total=127.5s`.**
  `mcp.StreamLifetime` is now **90s**, under both: the stream ends as a completed
  200 and the client reconnects as it already does. Nothing is lost by ending
  early — this server's tools, prompts and resources are static, so a listen
  stream has no notification to deliver. `TestStreamLifetimeClearsBothTimeouts`
  reads the 300s out of `terraform/modules/shorts-api/main.tf` rather than
  restating it, and carries the Cloudflare number with the probe that measured
  it (that one is a plan default, not in this repo). A test for this must use a
  data source — **a server with no tools honours no subscriptions and completes
  the listen instantly**, so against `Handler(nil)` it passes with the bound
  removed.
- **Tools call `ShortsServer` IN PROCESS**, skipping the Connect interceptor
  chain — which is why they are constrained to `VISIBILITY_PUBLIC` methods
  (`TestToolsOnlyCallPublicMethods`) and why rate limiting needed its own HTTP
  middleware rather than riding the interceptor.
- **Rate limiting is composed INSIDE the bearer middleware.** Outside it, the
  identity function sees no verified token and every authenticated caller is
  metered as anonymous.
- **`encoding/json` refuses `±Inf`; protojson does not.** Same value, two
  behaviours — which is why the website's screener worked while MCP's died.
  Guarded at the write funnel in `store/shorts/key_metrics_finite.go`. Note
  **Postgres accepts `-NaN`/`+NaN` where Go's `ParseFloat` does not**, so that
  guard cannot lean on `ParseFloat` alone.
- **The MCP SDK emits no `$defs`/`$ref`** — every nested struct is inlined at
  every use site. `tools/list` is ~97KB for 32 tools (99,763 of the 101,376 B budget), paid every session; the
  lever is fewer fields and fewer redundant descriptions, never flattening. An
  `int32` output field costs ~55 bytes of schema bounds an `int` does not.
- **The SDK exports no setter for `TokenInfo` in a context.** A test wanting an
  authenticated request must drive `auth.RequireBearerToken` — which is
  fortunate, because a faked context would pass even with the middleware
  composed in the wrong order.
- **`/mcp` is never cached and is not exempt from the edge.** A cached MCP
  response is one client's session served to another. Its edge bucket is
  `mcp-anon` (`m:<ip>`, 60/10s + 300/60s), resolved AFTER the credential check so
  presenting a token is never a downgrade.
- **Migration `000116` is in the deploy allowlist and REPLAYED every deploy** —
  every statement is `IF NOT EXISTS` and touches no rows. Supabase ships its own
  unrelated `auth.oauth_*` tables; ours are in `public`, so pin `search_path` on
  any hand-apply.

Full record: `docs/superpowers/handover-2026-08-29-mcp-oauth.md`.

**Admin MCP server — `/mcp/admin`** (`docs/mcp-admin.md`). A SECOND resource
for administrators, connected once as a claude.ai custom connector:
`publish_news_article` / `news_publish_status` (scope `news:publish`) and
`run_picks_job` / `picks_job_status` (scope `jobs:run`, starts `shorted picks
-mode fundamentals|filings|refresh|all` via a `run.developer` grant on that one
job, argv built server-side from the enum in `jobmonitor/picks.go`), the alerts
smoke test (`run_alerts_smoke_test`, `find_alert_crossing`, `alerts_status`,
`alerts_smoke_result`, `delete_alert_monitor`: the caller's own account only;
the replay is `shorted-alerts-replay` with the argv from
`jobmonitor/alerts_replay.go`, and the monitor rule is shared with the web
handlers through `services/shorts/internal/services/shorts/alerts_core.go`),
the `jobs:read` fleet tools, and the `users:read` personal-data tools
(`people_overview`, `list_users`, `list_paying_users`, `list_mailing_list`,
`lookup_person`: Firebase accounts via the web app's `/api/internal/admin-users`,
`api_subscriptions`, the `subscriptions` mailing list; minimal fields, every
call logged with its actor), and the housing crawl authorization
(`housing_crawl_rigs` / `housing_crawl_authorize`, scope `crawl:authorize`:
turns a BrandBrain rig on or off on both shorted's `housing_ingest_rigs` and
BrandBrain's `housing_crawl_v1` grant; `internal/brandbrain` is the client, and
`docs/mcp-admin.md` "Housing crawl authorization" has the sequencing). It is a
separate OAuth resource with its own scope vocabulary (`oauth/resources.go`) —
on the public server, the read-only rule has ONE exception: `alerts:write`
(`mcp.Scopes`), which unlocks the signed-in user's own alert tools. Constraints that
keep it safe, each tested: those tools are NOT in `Registry()`, and a
second prebuilt server lists them only to a request whose VERIFIED token carries the
scope (`HandlerWithAlerts`; `Stateless: true` stays on, the choice is per request);
anonymous and unscoped `tools/list` are the old list plus `manage_my_alerts`, and nothing else changes; the owner is the verified
token's uid and no tool takes one; every write goes through `alerts_core.go`; and a
token gets the scope only when it asks for it by name, never by default
(`mcp.DefaultScopes`). Any other write tool or non-`:read` scope still needs its own
decision, documented the same way. Admin scopes stay separate. Admin scopes name actions and are checked PER TOOL; the HTTP
layer requires at least one, never all, so adding a scope does not log an
existing connector out (a token minted before the scope gets a tool error
naming it). Admin = verified email on the web app's `ADMIN_EMAILS`, resolved
from the token's uid via the web app's `/api/internal/admin-check` and
re-checked at ticket, grant, token, every refresh and every request.

## Scheduled jobs on Kubernetes (Paprika on omega VKE, Telesis monitoring)

Scheduled batch jobs are moving from Cloud Scheduler → Cloud Run Jobs to
Kubernetes CronJobs on the omega VKE cluster: **`deploy/kubernetes/jobs/`**
(chart + Paprika Application + scripts; runbook in its `README.md`). Paprika
polls main and renders the chart into namespace `shorted-jobs`. The
`shorted cronjob-reporter` Deployment (`services/jobs/internal/jobs/cronreporter/`)
turns every Job's lifecycle into Telesis cron-monitor check-ins, and Telesis
alerts on failed, missed and timed-out runs. That replaces the GCP
`job-monitoring` policies for scheduled runs.

- **Cutover is two lists that must match**: `enabled:` in
  `deploy/kubernetes/jobs/chart/values.yaml` (unsuspends the CronJob) and
  `local.jobs_on_vke` in `terraform/environments/prod/main.tf` (pauses the
  Cloud Scheduler trigger). One without the other runs a job twice or not at
  all. `scripts/tests/vke-jobs-cutover.test.mjs` enforces it. Ships with both
  empty and `suspendAll: true`: nothing runs until a job is cut over.
- **Cloud Run jobs are NOT deleted.** Admin Run now, validation runs, news
  publish, the freshness/price-sync workflows and rollback all still use them.
  Until a job's Cloud Run definition is retired, **change its
  args/env/timeout in BOTH `values.yaml` and Terraform**. `chart/tests/render.sh`
  only pins schedules.
- **Cloud Run env is emulated.** `CLOUD_RUN_EXECUTION` = the Job name
  (short-data-sync resume key, price-sync report key). `CLOUD_RUN_TASK_ATTEMPT` =
  the Indexed Job's per-index failure count, so the Jobs must stay
  `completionMode: Indexed` + `backoffLimitPerIndex`.
- **Paprika tracks the `deploy/vke-jobs` branch, not main.** The deploy's `bump-vke-jobs-image` job moves it only after Terraform applies, so a cutover's CronJob can never go live before its Cloud Scheduler trigger is paused. When the Application tracked main, a failed image push on 2026-09-30 left six jobs live on both schedulers for about an hour.
- **Jobs still on Cloud Run are tracked too.** `cronjob-reporter` lists their executions through a keyless `vke-cronjob-reporter` identity (job-level `run.viewer`, `local.vke_reporter_watched_jobs`) and reports each run to the same Telesis monitor. An execution matches its monitor only by exact args and env, so keep chart `args` equal to the Cloud Run job's.
- **An ERROR log with exit 0 no longer pages** (the GCP log-metric policy did).
  Exit non-zero (`runner.ExitCodeError`) if a path should alert.
- Telesis **project tokens cannot register cron monitors** (user-role check).
  `register-monitors.py` needs `telesis login`. A read-role project token CAN
  read them (skunkworq/uptime project-token read access), which is how the
  admin job monitor shows cut-over jobs: a PAUSED Cloud Scheduler trigger whose
  name is a monitor's name (or its name plus `-schedule`) becomes state
  `CLUSTER` and takes its runs from Telesis (`jobmonitor/cluster.go`). Without
  `TELESIS_API_TOKEN` those jobs read as paused and overdue. Keep CronJob names
  matching their old trigger names, or the overlay cannot find them.

## Blog MDX palette (project-owned figures)

`/blog` posts (`web/_blogs/*.mdx`) use one component map,
`web/src/@/components/blog/mdx-components.tsx`. Editorial figures live in
`web/src/@/components/mdx/article-figures.tsx`: `Callout`, `Quote`, `Steps`,
`GraphStat`, `GraphRank` and `GraphTable`. They render semantic HTML on the
server, with ordinary CSS for layouts and bars. Extend these local components
when an article needs a new diagram; do not import or vendor mdxcn figures.

- **Use declarative attributes.** `next-mdx-remote` v6 blocks JavaScript
  expressions by default (`blockJS: true`). This is why `items={[...]}` and
  `max={30}` disappeared from the previous figure data; it is not a React
  Flight limitation. Keep that default and use JSON string attributes for
  `GraphStat`/`GraphRank` data, for example
  `items='[{"label":"Fawkner","value":29.7,"display":"29.7%"}]'`.
  Numeric options can use strings such as `max="30"`.
- `Steps` wraps a native Markdown ordered list, and `GraphTable` wraps a
  native Markdown table. `Callout` and `Quote` retain rich Markdown children.
  Figures do not inspect React children or use invisible marker components.
- The site's live islands (`Info`, `RegisterEmail`, `HousingChart`,
  `ScrollReveal`, `CountUp`) remain in the blog map. `BLOG_MDX_FIGURES` lists
  every name a post may use. Authoring examples and validation guidance:
  `docs/article-mdx.md`. Article layout and cover direction are defined in
  `docs/article-design.md` and `docs/blog-thumbnail-directions.md`; use versioned
  1600 × 900 art with descriptive `coverAlt` and matching `ogImage.url`.
  Use `.claude/skills/shorted-editorial-art/SKILL.md` for cover/thumbnail work,
  including material plausibility and collection review. Generate the smaller
  `thumbnailImage` card asset with `web/scripts/editorial-thumbnails.mts`.
- The newsroom palette is separate and already project-owned
  (`components/news/mdx/`). Its registry, manifest and take-writer prompt
  must stay in sync as described in `$newsroom`.

## Share & embed (charts and widgets)

Every embeddable widget carries a **Share** button (`components/ui/embed-dialog.tsx`;
the dialog body is a lazy chunk, `embed-dialog-content.tsx`). It offers a link,
the native share sheet where there is one, and copy per destination: Discord,
Slack, X, LinkedIn, Reddit, Markdown and Website (`lib/embed/share.ts`). Only
Website is the HTML `<figure>` snippet (`lib/embed/snippet.ts`, whose comment
explains the host-page credit); every other channel is a link plus a line,
because chat apps show HTML as text (a WBT snippet pasted into Discord,
2026-10-19).

| Piece | Where |
|---|---|
| Chart share page `/chart/<CODE>?view=&period=` | `app/chart/[code]/` (noindex, follow; no site chrome; params and fallbacks are `/embed/chart`'s, `app/embed/chart/params.ts`) |
| Its card `/chart/<CODE>/image` | `app/chart/[code]/image/route.tsx` + `lib/og/chart-image.ts` (geometry) + `lib/og/chart-card.tsx`: the chart itself, 1200x630, never a 500 |
| Landscape mode | `StockChartEmbed` `allowLandscape`: on a portrait phone the box is turned 90deg with CSS (`portrait:` variants), because rotation lock cannot be overridden and iOS has no orientation lock API |
| Indicators | `components/charts/chart-indicators.ts` (registry, base and advanced sets, warm-up plan), `chart-indicator-math.ts`, `indicator-layout.ts`, `indicator-menu.tsx`, `use-indicator-history.ts`. `StockChartEmbed` `indicators`: the share page `unlock: "session"`, the Discord Activity `unlock: "never"` (its sign-in is `onSignIn`, which opens outside Discord), `/embed/chart` none (the prop is omitted: no menu, no legend, no extra query) |

### Landmines

- **A chart as posted takes `?asof=&shorts=&prices=`.** `/chart/<CODE>`, `/chart/<CODE>/image`, `/embed/chart` and the Activity accept the three dates of an anchor (`chart-anchor.ts`: the posting day, the newest report and the newest close). A settled anchored card (posted 2+ days ago, report 8+ days old, complete with name and both logos) is cached 30 days at the CDN, and its data 7 days. Anything else uses the existing policies.
- **`/chart/` must stay out of robots.txt; `/embed/` stays in it.** Twitterbot
  and Slackbot honour robots.txt, so a disallowed share link posts with no
  preview. The share page keeps itself out of the index with its noindex meta.
  `robots-rpc-disallow.test.ts` pins both.
- **The card's Cache-Control key is lowercase** (`ImageResponse` spreads caller
  headers over its own `cache-control`; a capitalised key is appended to the
  one-year immutable default). A card missing a series it asked for is cached
  for 5 minutes, not 6 hours.
- **Never wrap a Discord link in `<angle brackets>`**: Discord suppresses the
  preview. Tickers are `ASX:CODE` on X, LinkedIn and Reddit (`$CODE` reads as
  a US cashtag).
- **The rotated chart reads the pointer through `getScreenCTM`** (visx
  `localPoint`), which includes the CSS rotation. A pointer path that uses
  `getBoundingClientRect` or `clientX` arithmetic would break scrubbing in
  landscape.
- **Nothing that positions with floating-ui may render inside the landscape
  box.** Radix Popover, DropdownMenu and Tooltip place themselves from
  `getBoundingClientRect`, which a rotated containing block breaks; a portal is
  unrotated and sits under the box's `z-[60]`. So the indicator menu is
  CSS-positioned inside the chart box and turns with it, and the Activity's
  search is an upright dialog at `z-[70]`.
- **The landscape box hears Escape on `window`, after every other listener,
  and ignores an Escape already handled (`defaultPrevented`).** Every handler
  that takes an Escape calls `preventDefault` (Radix does; the indicator menu
  does when the Escape comes from inside it, where focus is); one that does not
  leaves landscape on the same press. The host can hold the choice itself
  (`StockChartEmbed` `landscape`, controlled): the chart then only reports
  the toggle and Escape, and the host answers by changing it.
- **`chart-indicators.ts` imports only types from `chart-views.ts` and stays
  free of `"use client"`.** Server code (the share page's metadata, the bot's
  messages) reaches it through `chart-views.ts`, so a value import back is a
  module cycle. `indicator-menu.tsx` and `use-indicator-history.ts` are client
  modules imported only by `StockChartPanel` and `StockChartEmbed`, which are
  dynamic islands (`ssr-import-safety.test.ts` does not follow them).

## Discord bot (slash commands, live charts, Activity)

An HTTP interactions endpoint, not a gateway bot: Discord POSTs every command,
autocomplete keystroke and button press to `/api/discord/interactions`
(`web/src/app/api/discord/interactions/route.ts`; a GET reports its status),
signed with the app's Ed25519 key, and it deploys with the web app. Commands:
`/stock`, `/chart`, `/search`, `/top`, `/settings`, `/help`. A chart message is the
`/chart/<CODE>/image` card plus two rows of buttons (period, view) that redraw
it in place, and an **Interactive** button (`"activity": true`, on since
2026-10-23) that opens `StockChartEmbed` inside Discord as an Activity
(`/embed/discord`). Runbook and onboarding: `docs/discord-bot.md`.

| Piece | Where |
|---|---|
| Which app (id, public key, Activity switch), committed | `web/src/config/discord-app.json`; env `DISCORD_PUBLIC_KEY` / `DISCORD_ACTIVITY_ENABLED` override it for a second app |
| Onboarding and checks | `task discord:setup` / `discord:status` / `discord:register` (`web/scripts/discord.ts`; `DISCORD_CLIENT_SECRET` or `DISCORD_BOT_TOKEN` in the repo `.env`, never in Vercel; a client secret registers commands but cannot edit the app, so setup prints the endpoint URL and install settings as portal steps) |
| Public page (install buttons, commands, privacy) | `/docs/discord` (`web/src/app/docs/discord/page.tsx`); renders from `COMMANDS` and the committed app, so it needs no edit when either changes |
| Router, 1.5s fast path then defer + webhook edit (`waitUntil`) | `web/src/@/lib/discord/handler.ts` |
| Messages, commands (registered and handled from one list), button `custom_id` codec | `lib/discord/messages.ts`, `commands.ts`, `custom-id.ts` |
| Reads: the stock pages' server actions, 6s cap each | `lib/discord/data.ts` |
| Settings (default stock, view, period, interactive mode; per server or per person) | model `lib/discord/settings.ts`, Firestore `discord_settings` via `settings-store.ts`, signed link `settings-link.ts`, page `app/discord/settings/` (live preview from `buildChartMessage`), interactive-mode hand-off `launch.ts` + `/api/discord/activity/launch` |

### Landmines

- **Buttons carry their chart in `custom_id`** (`chart:p:BHP:short:3m`); old
  messages keep sending what they were posted with. Add kinds, never change one.
- **Kept-as-posted charts add three dates to the `custom_id`**: the posting day,
  the newest short report and the newest close
  (`chart:p:BHP:short:3m:20261104:20261028:20261103`). The bot reads the report
  and the close before it draws a new post, and posts live when either is unknown.
  A press copies the figures from `interaction.message` and never re-reads the
  stock, and one with no embed is refused privately. The forms without dates stay
  live, and a form's meaning never changes.
- **A chart message uploads its card** (`lib/discord/chart-card.ts`) as
  `attachment://<CODE>-<view>-<period>.png` in the deferred webhook edit; an
  interaction's HTTP response is JSON and cannot. The card's URL made Discord's
  media proxy fetch every redraw cold through Cloudflare, and a redrawn chart
  often stayed blank or stale (2026-10-31). The bot FETCHES the card from
  `/chart/<CODE>/image` (CDN-cached per day, with the first-party SSR marker and
  secret) and has the CDN draw the six charts one press away; it draws in its
  own function only as a fallback, because a render there blocks the function
  that must answer Discord within three seconds. The URL is the last resort.
- **The Interactive button hands its chart over by channel** (`launch.ts`):
  Discord does not pass the pressed button to the Activity, which otherwise
  opens the server's default stock.
- **The Activity loads `/`.** Discord's proxy (`<app id>.discordsays.com`,
  root mapping `shorted.com.au`) always opens the root with `frame_id` and
  `instance_id`, and `src/config/discord-activity.mjs` redirects those requests
  to `/embed/discord` (frameable). The proxy follows that redirect on the
  server, so the browser's address stays `/`. Next's router takes its initial
  URL from `window.location` (checked on 15.5.28: `createInitialRouterState`
  reads it before the first render), so every `usePathname()` check (the
  header, the footer, the corner credit, the banners) reads `/` and the page
  hydrates as the homepage: the site chrome renders and hydration fails (React
  #418 and #423). The root layout's inline `discordActivityHeadScript`, in
  `<head>`, moves the address to `/embed/discord` before the router reads it.
  The proxy also wraps the script it adds to `<head>` in newlines, and React 19
  rejects those injected text nodes during hydration (production #418), so on a
  `.discordsays.com` host the same script removes whitespace-only text from
  `<head>` before the page hydrates.
  Keep it a static inline script in `<head>`: the proxy adds a nonce to every
  inline script in the page, so a script created at runtime is blocked, and
  next/script, a `type="module"` script, an effect or the body can each run
  after the router has read the address. A script the proxy adds to `<head>`
  before this one is a hydration mismatch: on 15.5.28 React 19 logs a
  recoverable "A tree hydrated but some attributes ... didn't match" for the
  head's script element, and the Activity still renders. Placed after this
  script, React logs nothing (measured against `next dev` on 2026-11-03). The
  proxy case in `chart-surfaces.spec.ts` injects the proxy's real placement,
  newlines included. It passes on a production build with the sweep, and with
  the sweep disabled it fails with #418 (checked 2026-11-03). Its guards are
  `scripts/tests/discord-activity-redirect.test.mjs` (the placement, and the
  script run in a VM), `web/src/config/__tests__/discord-activity-url.test.ts`
  (it moves only what the server redirects) and the proxy case in
  `web/e2e/chart-surfaces.spec.ts` (it runs against a local server and was
  proved on `next start`; no workflow runs it). Inside the Activity only
  same-origin requests work, so it uses relative rewrites and opens links
  through the SDK.
- **`/api/discord/` is in the Cloudflare SBFM skip** (Discord is an automated
  client); the signature check is what keeps the route closed. So is the
  Activity: Discord's proxy fetches it from Discord's servers, and SBFM served
  it "Just a moment…". Its rule ("Allow the Discord Activity") opens
  `/embed/discord` and `/` ONLY with both `frame_id` and `instance_id`; keep
  the homepage itself challenged.
- **Activities and the URL mapping exist only in the developer portal** (no
  API field; the env's credential is a client secret, which cannot edit the
  app). `"activity": true` on an app without them shows a button that fails.
- **Proxy auth headers are a session pass, not request signing.** The proxy's
  `X-Discord-Proxy-Payload` signature covers the payload only (not path, method
  or body), so a valid set replays on any path until `expires_at`. Verify with
  `verifyDiscordProxyRequest` (signature over the exact bytes FIRST, then the
  times), never log the headers, and never let them authorise a write alone.
  Interactions share the key and the header names: `verifyDiscordRequest`
  accepts only a digits timestamp, which keeps the two messages apart.
  `/api/discord/activity` only observes today (docs/discord-bot.md, "Proxy
  authentication").
- `@vercel/functions` stays on 1.x: 3.x drags in an OIDC chain whose `jose`
  used to move next-auth's copy. With next-auth beta.32 next-auth resolves
  `jose` 6 and that chain nests its own `jose` 5 (a lockfile-only resolve,
  2026-11-03), so re-check the chain itself before moving.
- **A `/settings` link is a 30-minute bearer grant** for one scope, signed
  with a key derived from `NEXTAUTH_SECRET` (rotating it voids open links).
  Who may change a server's settings is Discord's decision (Manage Server, in
  the signed interaction); the page has no sign-in. `/discord/settings/open`
  moves the token into an httpOnly cookie scoped to the page, and every action
  re-reads the grant from it; nothing the browser sends picks the scope.
- **Nothing in the Activity may navigate the frame.** Discord's mobile webview
  follows a plain link in place and loaded the whole site inside the Activity
  (2026-10-29). The embed layout's corner credit is off on `/embed/discord`
  (`app/embed/embed-brand-link.tsx`), but that check reads `usePathname()`, so it
  holds only once the address fix above has run: without it the credit shows
  inside Discord. Links go out through `openExternalLink`. `openOutside` never calls `window.open` inside Discord
  (`inDiscordFrame`): it waits up to 3 seconds for the SDK, with the pressed control `aria-busy` meanwhile (Open on Shorted, or the menu's sign-in; see the in-flight rule below), and otherwise shows the address as text to
  copy, drawn in the chart's box (`chartOverlay`, an `absolute z-40` child that turns
  with a landscape chart; the announcement is an always-mounted `sr-only`
  status region in the Activity). An SDK that connects after the wait does not open the link afterwards. A later open that goes out clears the address, and so does a stock switch. A command Discord never answers releases the
  in-flight guard after 10 seconds (`LINK_SETTLE_MS`). While a link is in flight (`linkInFlight`) a press on any control does nothing. `opening` names the control that asked (`"open"`, `"sign-in"` or `"link"`), and only that control shows busy: the menu's sign-in button does so through `IndicatorSignIn.busy` (set from `signInBusy`), and it takes no press while busy. A stock switch releases the guard, clears the address and bumps `generation`, so a link that settles after it reports nothing, while one whose SDK answered in time still goes out.
  The link interceptor is on from mount, not once the handshake has finished,
  and it catches `auxclick` for a middle click only (a right click keeps its
  menu). The Activity renders no `<a>` at all (a test and the e2e spec both
  count them): search and **Open on Shorted** are buttons in the chart's header
  row (`headerActions`), and the advanced indicators' sign-in is `onSignIn`,
  not a link.
- **The Activity reads the screen once, and then the choice is its own.** A
  phone's own launch (`platform=mobile`) on a portrait phone starts turned
  sideways; the Activity holds that in its state (`landscapePref`, passed as the
  controlled `landscape`), outside the keyed chart, so every stock switch keeps
  it. It is never read again: a search's on-screen keyboard can reshape the
  screen mid-switch, and a re-read would turn the new chart upright. A frame's
  shape says nothing of the device (the `/discord/settings` preview is a portrait
  frame on a phone, and a desktop window can be narrow).
- **Search returns focus to its button however the dialog closes.** The Search
  button carries `aria-haspopup="dialog"` and `aria-expanded`; the dialog's
  `onCloseAutoFocus` puts focus back on it (`returnFocusTo`), since Radix would
  return focus to a chart a pick has just replaced.
- **Discord's in-app browser does not rotate.** **Open on Shorted** links to
  the share page with `landscape=1`, which opens the chart turned sideways on a
  phone held upright (`StockChartEmbed` `startLandscape`); only the bot's link
  carries it, and so does the Activity's sign-in hand-off (`activitySignInUrl`),
  which returns to the same share page turned sideways.

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

## Short-interest alerts (`shorted alerts`)

Monitors a customer creates on `/alerts` are evaluated by `shorted alerts`, a VKE
CronJob (`shorted-alerts`, hourly on weekdays at :55 UTC). It emails entitled owners
through Resend, one email per event, each with a signed one-click pause link. Code:
`services/jobs/internal/jobs/alerts/`. Shared contract: `services/pkg/alertevents`.
Operator runbook (before-merge steps, prod smoke test, troubleshooting):
`docs/alerts-runbook.md`.

- **VKE-native, no Cloud Run twin.** The job is in `vkeNative:` in
  `deploy/kubernetes/jobs/chart/values.yaml`. It has no `cloudRun:` mapping, and it is
  exempt from the twin checks in `render.sh` and `vke-jobs-cutover.test.mjs`. A
  second Cloud Run path would be a second way to send customer email.
- **Dry run is the default.** `ALERTS_DRY_RUN` unset means dry. Only `false` writes.
  The CronJob sets it.
- **The newest ASIC sync must have completed.** The gate reads only the ASIC recorder's
  `sync_status` rows (`environment` and `hostname` set); the market-data price sweep shares
  the table and is ignored. A failed, partial or unfinished sync
  can leave its last report part-written. Every unevaluated date is held (exit 10)
  until a completed sync lands. A running sync under two hours old makes the run wait
  (exit 0).
- **Token domain separation.** Alert tokens are `alert-monitor:<id>` signed with
  `UNSUBSCRIBE_SECRET`, so a newsletter link fails on the alert endpoint and an alert
  link fails on the newsletter endpoint. Tokens never expire (the Spam Act needs at least
  30 days). Rotating the secret breaks every link until two things are done: re-run
  `sync-secrets.sh` (the job keeps its own copy), and roll a new shorts API revision
  (Cloud Run resolves `latest` only when a revision starts).
- **Entitlement is the API's rule, pinned.** The job treats `ACTIVE` and `TRIALING` as
  entitled. `subscriptions_entitlement_contract_test.go` fails if the API's
  `ResolveEntitlement` disagrees. A customer who is not entitled gets
  `skipped_unentitled`, never an email.
- **`SHORTS_API_URL` is the Cloud Run origin**, not `api.shorted.com.au`. A per-user
  lookup through Cloudflare lands in the anonymous 10/10s bucket.
- **One owner's failed lookup holds only that owner.** An API-wide failure stops the
  run before commit. An owner's own failure leaves their events `awaiting_entitlement`,
  re-checked each run and expired after 48h.
- **Only a verified address is emailed, enforced in the API.** `Claims.EmailVerified` is set
  by the interceptor only: from Firebase's `email_verified` claim, or from the web's explicit
  `x-user-email-verified: true` on the alerts transport. Other web callers send `x-user-email`
  for their own reasons, so the address alone proves nothing. A bespoke API token is never
  verified. An unverified address is stored as NULL. The alerts list refreshes stored addresses
  to the verified one on each visit.
- **Active monitors are capped at 50 per user** (`shortsstore.MaxActiveAlertMonitors`). The cap
  is checked in the insert and the resume statement. Paused monitors do not count, and pausing
  is never refused.

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

### React 19 / Next 15 (the web app's upgrade, 2026-11)

- **Production runs Next's bundled React, not the `react` in `package.json`.**
  The App Router renders `next/dist/compiled/react`, which is
  `19.2.0-canary-0bdb9206-20250818` in Next 15.5.28. `react` and `react-dom` are
  pinned to 19.2.9, the nearest release, and Jest and Storybook run 19.2.9. Only
  a browser run against `next start` exercises production's React.
- **Next is the 15.5 line (15.5.28).** Next 16 removes the synchronous request
  APIs, `next lint` and `publicRuntimeConfig`, so it is a separate upgrade.
- **Request APIs are async.** `cookies()`, `headers()`, `params` and
  `searchParams` are awaited, and their types are `Promise<...>`. Never read
  them as plain objects.
- **Lint runs on the ESLint CLI, not `next lint`.** `npm run lint`
  (web/package.json) is `eslint` over `app pages components lib src` with the
  extensions `next lint` used by default. Only `src` exists in web/ today. On
  2026-11-03 the CLI linted the same files as `next lint` and reported the same
  messages. ESLint 8 and `.eslintrc.cjs` are unchanged;
  flat config is a separate change. `next build` still lints in 15.5 and still
  gates the build. **Next 16 removes `next lint`, and `next build` no longer
  runs linting (the `eslint` key in next.config goes too), so when upgrading,
  add a CI step that runs `npm run lint`.** Like `next lint`, the script lints
  only those five directories: code in any other top-level directory under
  web/ is not linted unless it is added to the script.
- **The build identity is baked in, not read at runtime.** `/api/version` reads
  `process.env.SHORTED_BUILD_*` and `NEXT_PUBLIC_RELEASE_COMMIT`, which
  `next.config.mjs` passes to `env` from `src/config/build-identity.mjs`. Next
  inlines them at build time, so `publicRuntimeConfig` and `next/config` are
  gone (Next 16 removes both). Keep each read a literal `process.env.NAME`: a
  dynamic lookup is not inlined, and the release tooling then reads `local`.
  The deploy job (`terraform-deploy.yml`, `deploy-vercel-prod`) sets
  `SHORTED_RELEASE_SHA` and `SHORTED_RELEASE_REF` for `vercel build`, which runs
  on the runner, so Vercel's git variables are absent: `gitCommit` is the
  release SHA's first seven characters and `gitBranch` is `main` for a push to
  main. Local builds report `local`.
- **Build concurrency:** `experimental.staticGenerationMaxConcurrency: 1`
  (Next 15 renders 8 pages per export worker by default). A failed call during
  the prerender bakes the fallback page (`bailOnEmptyRender`). Measured
  2026-11-03 from the Cuttlefish logs of five production deploys: the CI
  prerender took 8 to 12 s at concurrency 1 (Next 14: 18 to 21 s) with no
  rate-limit, retry or fallback lines, because CI builds against the Cloud Run
  URL directly ("Resolve Service URLs"). Local builds go through Cloudflare
  without the bypass secret, which is where local 429s come from. Kept at 1:
  the default 8 would save under 10 s of a ~6 minute deploy at up to 8x the
  concurrent API and database load (Supabase `max_connections` 60). Re-measure
  before raising it: `cuttle run logs <run> --project shorted --format ndjson
  --grep "Generating static pages"` (a `shorted` project login).
- **Client router cache:** `experimental.staleTimes: { dynamic: 30 }` keeps
  Next 14's 30 s for dynamic pages (Next 15 defaults to 0). The browser's
  requests count against the rate limits, so keep it.
- **The warm-cache routes are dynamic and take three credentials.** All four
  `api/*/warm-cache` routes and `api/warm-pages` are `force-dynamic` and call
  `isCacheWarmAuthorized` (`web/src/@/lib/cache-warm-auth.ts`). They accept
  Vercel Cron's `CRON_SECRET` bearer, the `REVALIDATION_SECRET` bearer (the
  deploy's prime step) and an `X-Cache-Warm-Secret` header. They never accept a
  query-string secret. On Vercel they refuse everything else, which with nothing
  configured is every request. Off Vercel with nothing configured they answer
  everyone, so local dev keeps working.
- **`next/dynamic` with `ssr: false` belongs in a client module** (see the stock
  page section). Next 15 refuses it in a server component.
- **Forms:** React 19 resets an uncontrolled form once its `action` completes
  without throwing, whatever the action answered. The admin trigger form
  (`web/src/app/admin/enrichments/trigger-enrichment-form.tsx`) therefore submits
  through `onSubmit`. It clears its stock code and Force box only when the API
  created a job (`created` on the action's result), and then says what it
  queued, in a `role="status"` line that is always mounted and is cleared when
  the next submit starts. The clear is on purpose: a Force box left ticked made
  the next code a forced re-enrichment, which is a paid GPT run. An answer that
  created no job (a pending review, or a job already running) keeps the fields
  and shows the API's message, because the admin still has to act on it. A
  failed trigger reaches the root error boundary (`web/src/app/error.tsx`), which
  replaces the page, so what was typed is lost on failure whichever way the form
  submits. The review form (`web/src/app/admin/enrichments/page.tsx`) keeps
  React 19's reset: a successful review redirects to `/admin/enrichments` without
  `?id=`, which unmounts its card, so the reset loses nothing the admin still
  needs. The sign-in form (`web/src/@/components/ui/sign-in.tsx`) has no fields
  and its action redirects to the sign-in page (`/signin`), so its reset loses
  nothing.
- **Head scripts:** Discord's proxy adds a script to `<head>` ahead of the
  Discord address script (layout.tsx), so that script carries
  `suppressHydrationWarning`. The Discord e2e case (`chart-surfaces.spec.ts`,
  "proxy") stays strict and passes on `next dev` and `next start`. Any other
  third-party head script placed ahead of the address script is still a
  hydration mismatch (see the Discord landmine).
- **A `next` option on a POST stays out of Next's data cache.** Next 15 keys byte
  and string bodies alike, so a `next: { revalidate, tags }` option on any non-GET
  request would store the response for the whole revalidate window, and an empty
  response (a cold materialized view, the kill switch) would then be served to
  every caller. Next 14 never stored a Connect byte body. `serverFetchWithUserAgent`
  (config.ts) sends every non-GET request that carries `next` around the patched
  fetch and registers the route's revalidate and tags through `unstable_cache`
  (`applyRoutePolicy`). The route keeps its window, and nothing is stored, so a
  read that many renders or requests share does not dedupe here. Those take
  `sharedRead` (actions/shared-read.ts): one `unstable_cache` entry for the
  window that throws on an empty answer, so only a good one is held. Today that
  is the short-interest rank list (`getShortRank.ts`), the industry treemaps
  (`getIndustryData.ts`, read by the force-dynamic /industry page), the report OG
  images' GetMarketByDate reads (`market-by-date.ts`, one day) and the sitemaps'
  GetTopShorts and treemap reads (`sitemap-sections.ts`, one hour). Do not add a
  static `next/cache` import to config.ts: client components import that module,
  and the policy helper only runs on the server.
- **Metadata on dynamic pages.** `htmlLimitedBots: /.*/` (next.config.mjs)
  resolves metadata before the shell for every request, as Next 14 did. Without
  it, Next 15 streams title, canonical and robots after the shell, and on dynamic
  pages those tags stay in `<body>` (measured on /industry, /search and /alerts).
  Only metadata waits; the body still streams.
- **Image routes honour their revalidate export.** A metadata image route with
  `revalidate = 86400` (the `opengraph-image` files) now regenerates daily, where
  Next 14 kept it until the next deploy. The suburb OG image
  (`housing/[state]/[suburb]`) has an empty `generateStaticParams`, so it is
  on-demand ISR: a miss, then cached, instead of a render on every request.
- **Typeface.** IBM Plex Mono is the app face (DESIGN.md), set through
  `--font-plex-mono`. next/font puts that variable on `<html>` and preloads the four
  latin files (weights 400 to 700, 40,360 bytes), with `adjustFontFallback: false`, so
  no generated Arial face draws the triangles and arrows Plex lacks. The `--font-sans`
  stacks in globals.css and critical-css.ts read the variable, with the literal name
  as the fallback. Plex sets 6.00px a character at 10px (`AXIS_CHAR_PX` is 6.1). Without
  the web font the stack reaches SF Mono on macOS, at 6.18px. First-load layout shift
  in Chromium through the e2e fixture, read 8 s after load, with the font files delayed
  1.5 s and undelayed in brackets: the stock page 0.002 at 1280px and 0.000 at 390px
  [0.002 and 0.001]; the homepage 0.043 at 1280px, where the swap lands at 1.5 s, and
  0.000 at 390px [0.001 and 0.001]; /strategies 0.000 at both widths [0.001 and 0.001]. Every
  case is under the 0.1 "good" line. WebKit exposes no layout-shift entries, so these
  are Chromium's figures. Windows and Linux are not measured.
- **next-auth beta.32 Edge warnings are expected.** `next build` prints "Compiled
  with warnings" for the middleware: `next-auth/jwt` pulls in `jose` 6, whose
  `deflate.js` calls CompressionStream and DecompressionStream, which the Edge
  Runtime build flags as unsupported. They are harmless. jose decompresses only a
  token whose header says `zip` (Auth.js never writes one), and only after the
  token's tag verifies, which needs `NEXTAUTH_SECRET`. A new Edge warning that
  does not point at that module is a real one.
- **visx 4 (2026-11).** Every `@visx/*` package is `^4.0.0` (the first release
  that takes React 19; 3.x caps React at 18), and the packages must match each
  other. Three rules come with it:
  - **Measure charts with `ParentSize` from `@/components/charts/parent-size`,
    never from `@visx/responsive`.** visx 4's `ParentSize` puts its children in
    an absolutely positioned, overflow-hidden box, so a wrapper whose height
    comes from its content (a chart drawn at a fixed height, a treemap sized
    from its width) collapses to 0px, and a tooltip near an edge is clipped.
    The local one is visx 3's layout on visx 4's `useParentSize` (same 300 ms
    debounce with a leading call, 0 x 0 until the first measurement).
  - **No deep `lib/` imports.** visx 4's `exports` map refuses
    `@visx/brush/lib/BaseBrush` and `@visx/responsive/lib/...` at runtime
    (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and `tsc` still passes because it resolves
    the files. Import types from the package root (`BrushProps`, `UpdateBrush`,
    `Bounds`, `BrushHandleRenderProps`). The `BaseBrush` class is exported by no
    root, so its ref type is `NonNullable<NonNullable<BrushProps["innerRef"]>["current"]>`.
  - **Declare every visx package the app imports.** `@visx/event` and
    `@visx/grid` are direct dependencies (they had been reached only through
    other visx packages, `@visx/grid` only through `@visx/xychart`, now removed).
    Do not add `@visx/xychart` back: it is unused. Path data comes from d3-shape
    3 (vendored in `@visx/vendor`), which rounds coordinates to three decimals:
    sub-pixel, not a visual change.

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

- **GCP Project**: `rosy-clover-477102-t5` (production; explicit operations only)
- **Region**: `australia-southeast2`
- **Artifact Registry**: `australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted`
- **Database**: Supabase (production), Docker PostgreSQL (development)
- **Gemini and bypass deploy secrets live in Cuttlefish, not GitHub**: the deploy jobs run on Cuttlefish runners and read `secrets.GEMINI_API_KEY*` and `secrets.CLOUDFLARE_*_BYPASS_SECRET` from its project store, so a GitHub repo secret of that name changes nothing for them. Set a value with `printf '%s' "$VALUE" | cuttle secrets set NAME --project shorted` (stdin; `--value` lands in shell history), after `cuttle login --project shorted`. A copy set with `--environment <env>` is read before the project copy by any job that names that environment, so check for one. The one GitHub-hosted reader is `rate-limit-sentinel.yml` (`ubuntu-latest`), which reads the GitHub repo copy of `CLOUDFLARE_SSR_BYPASS_SECRET`.
- **Gemini keys are validated before they sync**: `scripts/validate-gemini-key.sh` makes a real generation call and only a key that answers is written. A failing key leaves a warning and Secret Manager keeps its current version. A key with whitespace or a line break is refused before any request. `models.list` alone proves nothing.
- **A Gemini rotation touches every copy**: Cuttlefish (`GEMINI_API_KEY`; `SHORTED_GEMINI_API_KEY` holds the same key), Secret Manager (`GEMINI_API_KEY`, `_CHAT`, `_NEWS`, `_REPORT_EXTRACTOR`; the deploy writes the last three), and the VKE jobs (`deploy/kubernetes/jobs/scripts/sync-secrets.sh`, `CONFIRM=prod` to write). Change Cuttlefish first. A stale key that still generates passes the validator. `GEMINI_API_KEY_CHAT` in Cuttlefish is optional and unset today: while it is unset, every deploy writes the shared `GEMINI_API_KEY` into Secret Manager's `GEMINI_API_KEY_CHAT`, so a chat-only key needs `cuttle secrets set GEMINI_API_KEY_CHAT --project shorted` as well, or the next deploy replaces it.

### Terraform

```bash
cd terraform/environments/prod
terraform init
terraform plan
# Apply only through the reviewed deployment workflow.
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

**Operator/engineer reference: `docs/rate-limiting.md`** — caller classes and
what each is entitled to, the three-layer identity chain, the response contract,
and a debugging runbook (is it on? which class am I in? who is actually being
metered? is the quota store healthy? edge 429 or app 429?). What follows here is
the shape and the landmines; the numbers live in
`services/pkg/ratelimit/config.go`.

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

**Two surfaces — but only ONE is actually routed.** The worker script *handles*
two hostnames, and the client IP it would see differs on each: on the browser
route `cf-connecting-ip` is the **real end user**, whereas on the API route
traffic arriving via the Next.js rewrites in `web/next.config.mjs` comes from
**shared Vercel egress IPs** (an anon-IP bucket there would 429 real users en
masse, which is why the first cut shipped with enforcement off).

**However, as verified on 2026-08-23 the zone has exactly one worker route:
`api.shorted.com.au/*` (Terraform).** There is no `shorted.com.au/*` route —
the apex is a plain proxied A record to Vercel, so requests to the frontend
never enter the worker. Everything under `FRONTEND_HOST` in `worker.js`
(`proxyFrontend`, the `browser-anon` / `browser-auth` buckets, browser
`X-RateLimit-Bucket` values) is therefore **dead code today**. That is why
browser traffic records zero 429s — not because the limits are generous.
Adding the route would activate all of it at once, so treat it as a real
rollout with a real blast radius, not a config tweak.

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

**We never rate limit ourselves (August 2026).** The secret used to be
load-bearing in the worst way: marker present + secret missing/mismatched fell
through to `api-anon` (10/10s). Between 2026-08-22 and 08-23 that produced
**7,045 zone 429s**, all with UA `shorted-web-ssr/1.0`, all from four Azure IPs
— our **CI-side `vercel build` prerender**, which cannot read Vercel *sensitive*
env vars and so rendered every page unable to prove it was us. ~46% of its API
calls were rejected and fallback data was baked into the static output; nothing
alerted. The rule now:

> A first-party marker we cannot verify routes to the **`first-party` bucket**
> (600/10s) anyway and emits an **unsampled** `edge_bypass_used`
> (`outcome=rejected|unconfigured`). It is never treated as anonymous.

**Identifying the caller takes BOTH layers, and either alone does nothing.**
The worker strips `cf-connecting-ip` and `x-forwarded-for` before forwarding to
the origin (a client-supplied forwarded chain must never survive, or a caller
picks their own bucket) and then re-adds Cloudflare's own value —
`filterRequestHeaders` in `worker.js`. The origin believes those headers only
when the RIGHTMOST forwarded hop is a published Cloudflare address —
`resolveClientIP` in `services/pkg/ratelimit/http.go` — because Cloud Run is
publicly reachable and a direct caller could otherwise forge them. Measured
2026-08-30, the first day limiting ran: with the worker half missing, every
identifier in `api_usage_monthly` was a Cloudflare address, so every caller
behind a colo shared one bucket (30/min for a whole colo at the anonymous
tier). Fixing only the Go side changed nothing for 11 minutes of production
traffic, which is how the worker half was found.

**The app layer now mirrors this, and had to before `RATE_LIMIT_ENABLED` could
be true at all.** `classifyFirstParty` in `services/pkg/ratelimit/interceptor.go`
reads the same marker and the same header (`RATE_LIMIT_SSR_BYPASS_USER_AGENT` /
`_HEADER_NAME` / `_SECRET`, delivered to Cloud Run by the `shorts-api` module)
and yields tier `first-party` or `first-party-unverified`, keyed
`first-party:<egress ip>`. Same rule as the edge: an unverifiable marker is
still first-party. It differs only in what the secret buys — **monthly metering**
(200k unverified vs unmetered verified), never per-minute headroom, so our own
rendering cannot be throttled by a rotation while a spoofed header still cannot
buy unlimited scraping. Both layers must be renamed together.

`resolveRateLimitBypass` returns a third class, `ssr-unverified`, for this. The
secret is an **optimisation** (it lets verified traffic skip the zone rule), not
the thing standing between us and an outage — a rotation, a missed deploy or an
unreadable sensitive var now costs a log line, not our rendering. A spoofed UA
gets 600/10s instead of 10/10s: accepted, because the per-tier and monthly
limits run *after auth* where a UA buys nothing. The **testing** bypass is a
full skip and therefore stays fail-closed.

Corollaries that keep it that way:
- CI-side `vercel build` steps must be handed `SHORTED_SSR_BYPASS_SECRET`
  explicitly (from the Cuttlefish secret `CLOUDFLARE_SSR_BYPASS_SECRET`) — export-only,
  never as `--env`, which would downgrade the sensitive Vercel var.
- `SHORTS_SERVICE_ENDPOINT` must reach every build, or `getServerShortsApiUrl()`
  falls back to the **public** host and the whole prerender crosses Cloudflare
  from one runner IP. (`RELEASE_SHORTS_SERVICE_ENDPOINT` is currently unset —
  see below.)
- Every server-side Connect transport must use `serverFetchWithUserAgent` /
  `serverFetchOutsideNextCache`; enforced by `serverApiSurface.test.ts`.
- `serverFetchWithUserAgent` logs once per process when the secret is missing in
  a Vercel/CI environment, so a build log shows it next time.

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
`X-RateLimit-Tier`, `X-RateLimit-Access`, `X-RateLimit-Upgrade-Url`,
`Retry-After`, plus the per-minute/monthly headers above) so a plain `curl` or
a non-Connect client needs no parser.

**`access` is load-bearing for the upgrade copy, not decoration.** Paid
**browser** access is unlimited on both windows; paid **API** access is a real
120/min and 10,000/month ceiling. So "upgrade for unlimited requests" is true
on one surface and a broken promise on the other. `web/src/@/lib/retry.ts`
parses it into `RateLimitInfo.access`, `/rate-limit` accepts it as `?access=`
(that page is deep-linked from the API error body, so it is routinely shown to
API callers), and `rate-limit-notice.tsx` swaps both the CTA and the benefits
list on it. Regression coverage: `rate-limit-access-promise.test.tsx`.

The published tier tables in `api-key-manager.tsx` and `/docs/api` must match
`DefaultConfig` in `services/pkg/ratelimit/config.go` — enforced by
`api-key-manager-quota-contract.test.ts`, which parses the Go file rather than
restating it. They previously over-promised on three rows (anonymous 1,000 vs
an enforced 500, free 2,000 vs 1,000, paid per-minute "Unlimited" vs 120).

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

Browser tests send it to our own origins and localhost only: specs import
`test` from `web/e2e/helpers/test.ts` (`testing-bypass-scope.mjs` holds the
list), and release smoke uses `scoped-release-headers.mjs`. Never put it in
Playwright's `extraHTTPHeaders`, here or in a scratch script: those go to every
host a page contacts, and a stock page contacts Google (Analytics, Tag Manager,
the logo bucket) and Cloudflare's beacon. Until 2026-10-14 the shared config did
exactly that, so every e2e run with the secret set sent it to them.

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

The deploy passes it as `TF_VAR_rate_limit_ssr_bypass_secret` from the Cuttlefish
project secret `CLOUDFLARE_SSR_BYPASS_SECRET` (terraform-deploy.yml plan + apply).
The GitHub repo copy of the same name feeds only `rate-limit-sentinel.yml`, which
probes with it on a GitHub-hosted runner.

Web side: `web/src/app/actions/config.ts` attaches
`X-Shorted-Ssr-Bypass: $SHORTED_SSR_BYPASS_SECRET` in
`serverFetchWithUserAgent` **only** when that server-only env var is non-empty
**and** the request targets a shorted API origin (`api.shorted.com.au` or the
configured `SHORTS_SERVICE_ENDPOINT`/`SHORTS_API_URL`/`SHORTED_EDGE_API_URL`
host). It is **never** `NEXT_PUBLIC_*` and must never reach a client bundle or
a third-party host.

Mint + rotate (all four must be updated together — Cloudflare rule, the Cuttlefish
copy the deploy reads, the GitHub copy the sentinel reads, Vercel):
```bash
SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
# The Cuttlefish copy is the one the deploy reads. Updating only the GitHub copy
# leaves the deploy on the old value.
printf '%s' "$SECRET" | cuttle secrets set CLOUDFLARE_SSR_BYPASS_SECRET --project shorted
printf '%s' "$SECRET" | gh secret set CLOUDFLARE_SSR_BYPASS_SECRET --repo castlemilk/shorted.com.au
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

### A merge is not a deploy until its deploy has run

Every push to `main` deploys through `terraform-deploy.yml`, which Cuttlefish
runs (the workflow is disabled on GitHub, so `workflow_dispatch` there fails).
Its `deploy-vercel-prod` job builds and promotes the whole of `main` on every
push; there is no path filter. The workflow's concurrency group is
`deploy-refs/heads/main` with `cancel-in-progress: false`, so a push that lands
while a deploy is running is QUEUED, as on GitHub: its dispatch exists but has
no runs until the running deploy finishes, so `cuttlefish_runs_list` shows
nothing for it yet. A newer push replaces a queued one; only the newest `main`
waits.

On 2026-10-19 the queue's release was lost. #724 merged 50s after #725; its
deploy stayed queued after #725's had finished, and production stayed on #725
for nearly three hours while every check read green, until the next push to
`main` replaced it and deployed both. The fix is `skunkworq/cuttlefish` PR
#508: the reconciler starts a queued run once its group is free, and a push
that starts no run raises `gha_push_unstarted` in `cuttlefish_ci_triage`.

After a merge, a `gha-terraform-deploy-*` run for the merge commit appears
within a minute (`cuttlefish_runs_list`, project `shorted`), or, behind a
running deploy, as soon as that one finishes. If none ever starts,
`cuttle gha dispatch castlemilk/shorted.com.au terraform-deploy.yml --ref main --project shorted`
deploys `main` without another push. A deploy still waiting its turn needs
nothing; pushing again only replaces it in the queue.

## Versioning

The project uses git-based versioning. The version is automatically bumped on each frontend build via `web/scripts/bump-version.sh`, which generates versions like `v0.2.2-748-g032f59db`.

**Always commit changes** to keep the version info current. The version is displayed in the app and used for debugging deployed builds.
