# CLAUDE.md - Project Context for AI Assistants

This file provides context for AI coding assistants (Claude, Cursor, etc.) working on the Shorted.com.au codebase.

## Quick Start

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
| Daily Sync       | -    | `services/daily-sync/`           | Scheduled data updates                         |

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

1. **Define the protobuf** in `proto/shortedapi/shorts/v1alpha1/shorts.proto`:

   ```protobuf
   rpc GetNewEndpoint(GetNewEndpointRequest) returns (GetNewEndpointResponse) {
     option (google.api.http) = {
       post: "/v1/newEndpoint"
       body: "*"
     };
   }
   ```

2. **Generate code**:

   ```bash
   cd proto && buf generate
   ```

3. **Implement the handler** in `services/shorts/internal/services/shorts/service.go`

4. **Add store method** in `services/shorts/internal/store/shorts/store.go`

5. **Frontend types** are auto-generated in `web/src/gen/`

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

## Housing (feature + price tracker + suburb explorer)

The housing surface has three distinct deliverables that share a data layer and a chart system:

1. **`/features/the-widow-maker`** — a hand-built investigative editorial feature ("Why betting against Australian housing keeps failing"). Six numbered sections of prose with 4 embedded interactive `@visx` dashboards. Data is **baked** (curated research arrays, no RPC). Pinned into the `/news` masthead as a "Featured investigation" card.
2. **`/housing`** — a live **Australian House Prices Tracker** dashboard (BigStat tiles + capital-city medians + amber series charts), fed by a real ABS/RBA ingest pipeline (`house-price-collector` → `house_prices` table → `GetHousingOverview`/`GetHousePriceSeries` RPCs).
3. **The suburb explorer** (`/housing` national states map → `/housing/[state]` suburb choropleth + list → `/housing/[state]/[suburb]` profile) — a national→state→suburb **choropleth drilldown** over real ABS TopoJSON boundaries, with a **"Colour by" metric toggle** across house price, ABS Census demographics + culture (religion/language/born-overseas), and **electoral representation** (federal + state member/party + two-party-preferred lean). One `suburb_demographics` table (keyed by ABS `sal_code`) → `ListStateSuburbs`/`GetSuburbProfile` RPCs. **LIVE on prod.**

A **Tier-3 stealth crawl** of REA/Domain suburb medians exists in the collector but is **opt-in, anti-poisoning, licence-gated, and does not yet actually scrape** (Kasada/Akamai serve poison/403; no solver wired).

### Key files

| File | Purpose |
|------|---------|
| `web/src/app/features/the-widow-maker/page.tsx` | Editorial feature server page (6 sections, JSON-LD, `revalidate: 3600`) |
| `web/src/@/components/features/housing/` | Editorial primitives: `hero`, `section`, `pull-quote`, `cite`, `stat-strip`, `feature-chart-frame`, `scroll-reveal`, `sources-list` |
| `web/src/@/components/features/housing/dashboards.tsx` | `"use client"` `dynamic(ssr:false)` wrappers for the 4 feature charts + BankShortBasket |
| `web/src/@/components/features/housing/charts/` | `policy-price-chart`, `buying-power-chart`, `international-corrections-chart`, `borrowing-power-slider` + `chart-theme.ts`, `chart-ui.tsx` |
| `web/src/@/components/features/housing/data/` | `series.ts` (baked arrays), `sources.ts` (27-source bibliography + `getSource`), `stats.ts`, `types.ts` |
| `web/src/@/components/news/masthead/featured.ts` | `FEATURED[]` registry — masthead pins `FEATURED[0]` |
| `web/src/app/housing/page.tsx` | Live tracker SSR page (tiles + charts) |
| `web/src/@/components/housing/` | `housing-tiles.tsx`, `housing-charts.tsx` (dynamic wrapper), `housing-series-chart.tsx` (live RPC + format-key) |
| `web/src/app/actions/getHousing.ts` / `client/getHousingClient.ts` | SSR action (`cache()`+retry) / client action (session cache + backoff) |
| `web/src/@/components/housing/choropleth-map.tsx` | Shared d3-geo/d3-zoom choropleth (continuous **or** categorical fill, `focusId` zoom-to-feature, `MAX_SCALE=48`, `non-scaling-stroke`) |
| `web/src/@/components/housing/` (suburb) | `national-housing-map.tsx`, `state-suburb-explorer.tsx`, `state-suburb-map.tsx`, `suburb-tooltip.tsx`, `suburb-profile.tsx`, `categorical-legend.tsx`, `map-legend.tsx` |
| `web/src/@/lib/housing/highlight-metrics.ts` | `HIGHLIGHT_METRICS` "Colour by" registry — continuous (amber/diverging `federal_lean`) + categorical (religion/language/`federal_party`/`state_party` palettes) |
| `web/public/geo/{states.topojson,suburbs/<ST>.topojson}` | ABS ASGS 2021 boundaries (built by `web/scripts/geo/build-boundaries.mjs`) |
| `web/public/geo/electorates/*.json` | Precomputed federal/state spatial-join output (see data-prep below) |
| `web/scripts/geo/` | One-time data prep: `build-boundaries.mjs`, `join-electorates.mjs`, `join-sed.mjs`, `fetch-state-members.py` (+ `README.md`) |
| `services/migrations/000053…000060` | `000053/054` price tracker (`house_prices` EAV + `mv_housing_headline` + licence gate); `000055` `suburb_demographics` + `house_price_regions.sal_code`; `000056` sal_code backfill; `000057` culture; `000058/059/060` federal/state-district/state-member electoral |
| `services/house-price-collector/` | `main.go` (`-mode official\|census\|electorates\|crawl\|refresh\|all`), `abs.go`, `rba.go`, `census*.go`, `electorates.go`, `store.go`, `crawl*.go` |
| `services/shorts/internal/services/shorts/house_prices.go` + `store/shorts/postgres_house_prices.go` | RPC handlers + queries |
| `proto/shortedapi/shorts/v1alpha1/shorts.proto` | `GetHousingOverview` / `GetHousePriceSeries` / `ListStateSuburbs` / `GetSuburbProfile` (+ `ListHousingRegions`) |
| `terraform/modules/house-price-collector/` | Cloud Run Job + monthly scheduler (built, **NOT yet wired** into envs/CI) |

### Data sources & live-vs-baked

- **LIVE** (collector fetches each run): ABS `RES_DWELL_ST` (mean_price, total_value — national+states), ABS `RES_DWELL` (median_price by dwelling for GCCSAs), ABS `RPPI` (price_index, but frozen at 2021-Q4 upstream), RBA `E2` (debt_to_income). All CC-BY-4.0.
- **BAKED** (transcribed arrays in `data/series.ts`, only the feature uses these): BIS real HPI for AUS/JPN/USA/CHN (FRED, never fetched), OECD price-to-income, ABS Lending Indicators investor share, ATO negatively-geared landlords.
- **CRAWL** (`source_licence='proprietary-tos-restricted'`, never republished): `crawl_rea`, `crawl_domain` — currently blocked, no values stored.
- **SUBURB EXPLORER** (`suburb_demographics`, keyed by ABS `sal_code`): ABS Census 2021 GCP **SAL DataPack** (G01 birthplace/language, G02 medians, G13A–E language, G14 religion — `-mode census`); AEC 2025 election (boundaries + tally-room **event 31496** members + 2PP) + ABS `SED_2025` state districts, both joined to suburbs by **centroid point-in-polygon** in `web/scripts/geo/` (`-mode electorates`); state members from each state's Wikipedia "Members of the Legislative Assembly" table (`fetch-state-members.py`, 6 single-member states; TAS/ACT Hare-Clark → `state_member` NULL by design). All ABS/AEC CC-BY-4.0.

### Prod-ops gotchas

- **DDL on prod Supabase**: apply `000053` via the **session pooler port 5432** (not the txn pooler 6543) with `PGOPTIONS="-c statement_timeout=0"` so `REFRESH MATERIALIZED VIEW CONCURRENTLY` can run. The collector's `store.go` uses port 6543 + `QueryExecModeSimpleProtocol` for normal writes.
- **ABS WAF**: `abs.go` MUST send `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)` + `Accept: application/vnd.sdmx.data+csv;labels=both`; bare requests are WAF-blocked (same posture as other project fetches). The crawl tier gets browser-realistic TLS/headers automatically from `stealthhttp`'s native engine — don't hand-set a UA there.
- **SSR vs rewrite env split**: server components/actions read `NEXT_PUBLIC_API_URL` (internal rewrite-proxy) first; client components fall back to `NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT`. Use `getShortsApiUrl()` from `app/actions/config.ts`, never the env var directly.
- **Charts can't SSR**: every interactive chart is imported via `dynamic(..., { ssr: false })` from a `"use client"` module (`dashboards.tsx`, `housing-charts.tsx`) — connect-web + measure-on-client crash SSR otherwise.
- **Functions can't cross the RSC boundary**: `housing-series-chart.tsx` passes a serializable `format="aud"|"percent"|"index"` key and looks up the formatter in a client-side `FORMATTERS` map — never pass a formatter function as a prop from the server page.
- **Satori OG limitation**: `opengraph-image.tsx` uses `linear-gradient` (not sized `radial-gradient`, which satori can't parse) and Georgia/system fonts (no webfont). The `/news` featured card recreates the same bloom with a CSS `radial-gradient` (which is fine in the browser, just not in OG).
- **MV refresh is decoupled**: `refresh_housing_materialized_views()` is separate from the daily shorts `refresh_all_materialized_views()`; the collector calls it post-ingest.
- **Suburb explorer is manual-ingest**: `-mode census` needs `CENSUS_DATAPACK_PATH` (ABS GCP SAL zip) + `CENSUS_GEO_DIR` (the boundary TopoJSON, used as the authoritative `sal_code` registry); `-mode electorates` needs `ELECTORATES_DIR` (the committed `web/public/geo/electorates/*.json`). The boundary→suburb spatial join is **precomputed once** by the `web/scripts/geo/*.mjs` scripts — the collector only loads + upserts, no GIS at ingest time. After re-running `-mode census`, re-apply migration `000056` (the `house_price_regions.sal_code` backfill reads the now-populated `suburb_demographics`).
- **Electoral data-prep landmines** (when refreshing after an election/redistribution): AEC boundary file casing (`O'connor`) differs from the results CSV (`O'Connor`) — match **case-insensitively**, keep the CSV name (skipping this drops ~950 suburbs); ABS SED names carry a `District (Region)` qualifier (`Bass (Launceston)`) that `join-sed.mjs` strips; party-abbreviation matching in `fetch-state-members.py` substring-matches surnames unless restricted to full party names (len>4) with abbreviations exact-only (`LNP`/`CLP`/`ON` are exact keys).
- **Choropleth fill modes + no function props**: `choropleth-map.tsx` takes either `valueById`+`colorScale` (continuous) or `categoryById`+`categoryColor` (categorical — religion/language/party use **distinct colours per category, not gradients**). The metric is dispatched by a serializable `MetricKey` from `highlight-metrics.ts` — never pass a scale/formatter function across the RSC boundary (same rule as the price-tracker format-key). Suburb paths need `vector-effect: non-scaling-stroke` or the emphasis stroke swallows small suburbs at deep zoom.

### Pointers

- Full architecture + extension recipes: `docs/housing-architecture.md` (§5 = the suburb explorer data model; §7 = data model & licensing; §9 = extension recipes).
- Adding a new feature dashboard, a new ABS measure/region, a new RPC, wiring the feature charts to live data, **a new suburb-map highlight metric (recipe G), a new ABS Census measure (recipe H), or refreshing the electoral layer after an election (recipe I)**: see the "Future extensions" section of that doc.

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

### Vercel Environment Variables — Trailing Newlines

Vercel project-level env vars can have trailing `\n` baked into JS bundles. Always `.trim()` client-side config values (e.g., Firebase config in `firebase-client.ts`). CI/CD `--build-env` flags pass clean values, masking the issue.

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

The API uses Upstash Redis for rate limiting with a sliding window algorithm.

### Rate Limit Tiers

**API Access** (programmatic, via API tokens):

| Tier | Per Minute | Per Month | Description |
|------|------------|-----------|-------------|
| `anonymous` | 30 | 1,000 | Unauthenticated requests (by IP address) |
| `free` | 60 | 2,000 | Authenticated users without paid subscription |
| `paid` | unlimited | **10,000** | Users with any active paid subscription |

**Browser Access** (web app, via Firebase auth):

| Tier | Per Minute | Per Month | Description |
|------|------------|-----------|-------------|
| `anonymous` | 60 | 5,000 | Unauthenticated browser requests |
| `free` | 120 | 10,000 | Authenticated without subscription |
| `paid` | **unlimited** | **unlimited** | Paid subscribers have no limits |

### How It Works

1. **Authentication** - User authenticates via Firebase (browser) or API token (programmatic)
2. **Access Type Detection** - Firebase auth → browser access, API token → API access
3. **Subscription Lookup** - Auth interceptor queries `api_subscriptions` table for user's tier
4. **Rate Check** - Applies browser or API limits based on access type

### Response Headers

All responses include rate limit headers:
```
X-RateLimit-Limit: 60              # Per-minute limit (0 = unlimited)
X-RateLimit-Remaining: 55          # Per-minute remaining
X-RateLimit-Reset: 1706918400      # Per-minute reset timestamp
X-RateLimit-Monthly-Limit: 10000   # Monthly limit
X-RateLimit-Monthly-Used: 150      # Monthly usage
X-RateLimit-Monthly-Reset: 1709251200  # Start of next month
```

When rate limited, returns HTTP 429 with `Retry-After` header.

### Configuration

Environment variables:
```bash
UPSTASH_REDIS_REST_URL=https://amazed-cow-5075.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>
RATE_LIMIT_ENABLED=true
```

### Cloudflare Edge Test Bypass

The Cloudflare edge rate limit is separate from the app/Upstash limits. It can be bypassed for trusted E2E/load testing, but only with both a user-agent marker and a secret header.

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

### Cost Attribution Observability

Cloudflare RUM should use Cloudflare automatic Web Analytics injection for proxied production hostnames (`shorted.com.au`, `www.shorted.com.au`); Terraform manages the zone RUM switch via `cloudflare_zone_setting.web_analytics_rum`. The app component `web/src/@/components/cloudflare-web-analytics.tsx` is a disabled-by-default app-managed fallback and only renders when `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED=1` plus a hostname-correct `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` are set. The fallback must use `data-cf-beacon` with `send: { to: "/cdn-cgi/rum" }` so browser beacons post to the same-origin Cloudflare endpoint, not `cloudflareinsights.com/cdn-cgi/rum`. Cost attribution joins Cloudflare RUM page views with Worker `edge_request`, Firestore `firestore_operation`, product funnel `product_event`, and backend AI `cost_event` JSON logs. Query examples and field contracts live in `docs/observability/cost-attribution.md`.

For production incident triage, use `$shorted-prod-troubleshooting` to combine RUM/analytics with Vercel logs, Worker versions, release-smoke results, API edge checks, and database verification.

### Key Files

| File | Purpose |
|------|---------|
| `services/pkg/ratelimit/` | Rate limiting package |
| `services/pkg/ratelimit/config.go` | Tier configuration |
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
