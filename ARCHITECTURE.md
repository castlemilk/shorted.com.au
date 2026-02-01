# Architecture Documentation: Shorted.com.au

**Generated:** 2026-02-01
**Version:** 1.0
**Purpose:** Comprehensive architecture reference for development and maintenance.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Service Architecture](#2-service-architecture)
3. [Data Flow](#3-data-flow)
4. [Database Schema](#4-database-schema)
5. [API Surface](#5-api-surface)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Infrastructure & Deployment](#8-infrastructure--deployment)
9. [External Integrations](#9-external-integrations)
10. [Known Issues & Technical Debt](#10-known-issues--technical-debt)

---

## 1. System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA SOURCES                                        │
├─────────────────────┬─────────────────────┬─────────────────────────────────────┤
│    ASIC CSV Files   │   Yahoo Finance     │         OpenAI GPT-4                │
│  (Short Positions)  │  (Stock Prices)     │      (Company Enrichment)           │
└─────────┬───────────┴─────────┬───────────┴──────────────┬──────────────────────┘
          │                     │                          │
          ▼                     ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DATA PIPELINE LAYER                                    │
├─────────────────────┬─────────────────────┬─────────────────────────────────────┤
│    Daily Sync       │  Market Data Sync   │     Enrichment Processor            │
│  (Cloud Run Job)    │   (Cloud Run Job)   │      (Cloud Run Service)            │
│   Python + Go       │        Go           │     Go + Python (ML models)         │
│  Scheduled 2AM AEST │   On-demand/Daily   │        On-demand                    │
└─────────┬───────────┴─────────┬───────────┴──────────────┬──────────────────────┘
          │                     │                          │
          └─────────────────────┼──────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DATA STORAGE LAYER                                     │
├────────────────────────────────┬────────────────────────────────────────────────┤
│       PostgreSQL (Supabase)    │           Google Cloud Storage                  │
│                                │                                                 │
│  • shorts (~2.1M rows)         │  • shorted-short-selling-data (ASIC CSVs)      │
│  • stock_prices (~3.7M rows)   │  • shorted-logos (processed logos)             │
│  • company-metadata (~4.5K)    │                                                 │
│  • api_subscriptions           │                                                 │
│  • enrichment_pending          │                                                 │
│  • Materialized Views (3)      │                                                 │
└────────────────────────────────┴────────────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           API SERVICES LAYER                                     │
├─────────────────────┬─────────────────────┬─────────────────────────────────────┤
│    Shorts API       │   Market Data API   │          Algolia                    │
│  (Cloud Run)        │    (Cloud Run)      │    (Search Index)                   │
│   Go + Connect-RPC  │   Go + Connect-RPC  │     ~4.5K records                   │
│   Port 9091         │     Port 8090       │                                     │
└─────────┬───────────┴─────────┬───────────┴──────────────┬──────────────────────┘
          │                     │                          │
          └─────────────────────┼──────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND LAYER                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                       Next.js 14 (Vercel)                                        │
│                                                                                  │
│  • Server Components: Server-side API calls with Google ID token auth           │
│  • Client Components: React Query + Connect-RPC                                  │
│  • Search: Algolia InstantSearch                                                 │
│  • Auth: NextAuth.js v5 + Firebase Auth                                          │
│  • Payments: Stripe Checkout                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, TypeScript, TailwindCSS, Radix UI, Visx Charts |
| Backend | Go 1.23+, Connect-RPC (gRPC-Web) |
| Database | PostgreSQL (Supabase), Firestore (user data) |
| Search | Algolia |
| Auth | NextAuth.js v5, Firebase Auth, Google OAuth |
| Payments | Stripe |
| Infrastructure | GCP Cloud Run, Terraform, Vercel |
| CI/CD | GitHub Actions |

### Codebase Metrics

| Metric | Value |
|--------|-------|
| Go Code (backend) | ~32,000 lines |
| TypeScript (frontend) | ~64,000 lines |
| Protobuf definitions | ~2,000 lines |
| Test files | 36 (backend), Jest/Playwright (frontend) |
| Database rows | ~5.8M total |

---

## 2. Service Architecture

### Service Catalog

| Service | Port | Language | Purpose | Scaling |
|---------|------|----------|---------|---------|
| **Shorts API** | 9091 | Go | Main API for short positions, metadata, subscriptions | 0-10 instances |
| **Market Data API** | 8090 | Go | Stock prices, correlations | 0-5 instances |
| **Enrichment Processor** | 8080 | Go + Python | GPT-4 enrichment, logo processing | 0-10 instances |
| **Daily Sync** | - | Python + Go | Scheduled data ingestion | Job (daily) |
| **Market Data Sync** | - | Go | Incremental price updates | Job (on-demand) |
| **ASX Discovery** | - | Go | Company discovery from ASX | Job (on-demand) |
| **Frontend** | 3020 | TypeScript | Next.js web application | Vercel auto-scale |

### Service Communication

```
Frontend ──Connect-RPC──▶ Shorts API ──SQL──▶ PostgreSQL
    │                         │
    │                         ├──gRPC──▶ Enrichment Processor
    │                         │
    ├──Connect-RPC──▶ Market Data API ──SQL──▶ PostgreSQL
    │
    ├──REST──▶ /api/stripe/* ──Webhook──▶ Shorts API
    │
    └──HTTP──▶ Algolia Search Index
```

### Go Module Structure

```
services/
├── go.mod                    # Main module
├── shorts/                   # Shorts API service
│   ├── cmd/server/main.go   # Entry point
│   └── internal/
│       ├── services/shorts/ # RPC handlers
│       └── store/shorts/    # Database layer
├── market-data/             # Market Data service (standalone main.go)
├── market-data-sync/        # Price sync job
├── enrichment-processor/    # GPT-4 enrichment
├── daily-sync/              # ASIC data sync
├── asx-discovery/           # ASX company discovery
├── pkg/                     # Shared packages
│   ├── enrichment/          # Enrichment utilities
│   └── log/                 # Logging (zap-based)
├── gen/                     # Generated protobuf code
└── migrations/              # Database migrations
```

---

## 3. Data Flow

### Daily ASIC Data Sync

```
┌───────────────────────────────────────────────────────────────────┐
│                    DAILY SYNC (2 AM AEST)                         │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. Download ASIC CSV Files                                       │
│    https://www.asic.gov.au/regulatory-resources/...             │
│    → Store in GCS: shorted-short-selling-data bucket            │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Parse CSV → Insert/Update shorts table                        │
│    • UPSERT on (DATE, PRODUCT_CODE)                              │
│    • Filter out "DEFERRED SETTLEMENT" products                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Sync Stock Prices (Yahoo Finance)                            │
│    • Fetch prices for all active stocks                          │
│    • UPSERT into stock_prices table                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Refresh Materialized Views                                    │
│    SELECT refresh_all_materialized_views();                      │
│    • mv_top_shorts (top shorted stocks)                          │
│    • mv_treemap_data (industry heatmap)                          │
│    • mv_watchlist_defaults (default watchlist)                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Sync Algolia Index                                            │
│    • Update stocks index with latest metadata                    │
│    • ~4.5K records                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Enrichment Pipeline

```
Admin Triggers Enrichment (EnrichStock RPC)
                    │
                    ▼
        ┌───────────────────────┐
        │ Create Enrichment Job │
        │ (enrichment_jobs)     │
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │ Enrichment Processor  │
        │                       │
        │  ┌─────────────────┐  │
        │  │ GPT-4 Summary   │  │
        │  ├─────────────────┤  │
        │  │ Logo Discovery  │  │
        │  │ (MobileSAM)     │  │
        │  ├─────────────────┤  │
        │  │ Website Scrape  │  │
        │  ├─────────────────┤  │
        │  │ Social Media    │  │
        │  └─────────────────┘  │
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │ Save to enrichment_   │
        │ pending (for review)  │
        └───────────┬───────────┘
                    │
                    ▼
            Admin Reviews
           ┌────────┴────────┐
           │                 │
       Approve            Reject
           │                 │
           ▼                 ▼
    Apply to company-    Status: REJECTED
    metadata table
           │
           ▼
    Status: COMPLETED
```

### User Request Flow

```
User Browser
     │
     │ HTTPS
     ▼
┌─────────────────┐
│ Vercel Edge     │──(Static assets, SSR)
│ (CDN + Compute) │
└────────┬────────┘
         │
         │ Server Actions / API Routes
         ▼
┌─────────────────────────────────────────────────────┐
│           Next.js Server (Vercel Function)          │
│                                                     │
│  getAuthHeaders() → Google ID Token (production)   │
│                   → X-Internal-Secret (dev)        │
└────────┬────────────────────┬───────────────────────┘
         │                    │
         │ Connect-RPC        │ Connect-RPC
         ▼                    ▼
┌─────────────────┐   ┌─────────────────┐
│   Shorts API    │   │ Market Data API │
│  (Cloud Run)    │   │   (Cloud Run)   │
└────────┬────────┘   └────────┬────────┘
         │                     │
         │ pgx (Postgres)      │ pgx (Postgres)
         ▼                     ▼
┌─────────────────────────────────────────────────────┐
│              PostgreSQL (Supabase)                  │
│         Transaction Pooler (Port 6543)             │
└─────────────────────────────────────────────────────┘
```

---

## 4. Database Schema

### Core Tables

#### `shorts` (~2.1M rows)
ASIC short position data (uppercase columns from CSV).

```sql
"DATE" timestamp                    -- Report date
"PRODUCT" text                      -- Company name
"PRODUCT_CODE" text                 -- ASX code (e.g., 'BHP')
"REPORTED_SHORT_POSITIONS" float    -- Shares shorted
"TOTAL_PRODUCT_IN_ISSUE" float      -- Total shares on issue
"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float

-- Key Indexes:
-- shorts_date_product_code_unique: UNIQUE(DATE, PRODUCT_CODE)
-- idx_shorts_product_code_date: (PRODUCT_CODE, DATE DESC) for time series
-- idx_shorts_timeseries_covering: Covering index for common queries
-- idx_shorts_percent_nonzero: Partial index for non-zero percentages
```

#### `stock_prices` (~3.7M rows)
Historical stock prices.

```sql
stock_code VARCHAR     -- ASX code
date DATE              -- Trading date
open DECIMAL           -- Open price
high DECIMAL           -- High price
low DECIMAL            -- Low price
close DECIMAL          -- Close price
adjusted_close DECIMAL -- Adjusted for splits/dividends
volume BIGINT          -- Trading volume

-- Key Indexes:
-- stock_prices_stock_code_date_key: UNIQUE(stock_code, date)
-- idx_stock_prices_stock_date: (stock_code, date DESC)
```

#### `company-metadata` (~4.5K rows)
Company information and GPT-4 enrichment.

```sql
-- Base metadata
stock_code VARCHAR(50) UNIQUE PRIMARY KEY
company_name VARCHAR(255)
sector, industry VARCHAR(100)
market_cap BIGINT
website VARCHAR(500)
description TEXT

-- Logo URLs
logo_gcs_url TEXT           -- Full PNG logo
logo_icon_gcs_url TEXT      -- Icon-only PNG
logo_svg_gcs_url TEXT       -- Original SVG (if available)
logo_source_url TEXT        -- Where logo was found
logo_format TEXT            -- svg, png, etc.

-- GPT-4 Enrichment
enhanced_summary TEXT
company_history TEXT
key_people JSONB            -- [{name, role, bio}]
competitive_advantages TEXT
risk_factors TEXT
recent_developments TEXT
social_media_links JSONB    -- {twitter, linkedin, facebook}
tags TEXT[]

-- Key Metrics (Yahoo Finance)
key_metrics JSONB           -- {market_cap, pe_ratio, eps, dividend_yield, beta, ...}
key_metrics_updated_at TIMESTAMP

-- Enrichment Status
enrichment_status VARCHAR(50)
enrichment_date TIMESTAMP
enrichment_error TEXT

-- Full-text Search
search_vector TSVECTOR
```

#### `api_subscriptions`
Stripe subscription tracking.

```sql
id UUID PRIMARY KEY
user_id VARCHAR(255) UNIQUE    -- Firebase UID
user_email VARCHAR(255)
stripe_customer_id VARCHAR(255) UNIQUE
stripe_subscription_id VARCHAR(255)
status VARCHAR(50)             -- active, canceled, past_due, trialing, inactive
tier VARCHAR(50)               -- free, pro, enterprise
current_period_start TIMESTAMP
current_period_end TIMESTAMP
cancel_at_period_end BOOLEAN
created_at, updated_at TIMESTAMP
```

### Materialized Views (Performance)

| View | Rows | Purpose | Query Time |
|------|------|---------|------------|
| `mv_top_shorts` | ~940 | Pre-computed top shorted stocks | ~6ms |
| `mv_treemap_data` | ~6.2K | Industry treemap by period | ~3ms |
| `mv_watchlist_defaults` | 8 | Default watchlist stocks | <1ms |

**Performance Impact:**
- GetTopShorts: 2,300ms → 6ms (**380x faster**)
- GetIndustryTreeMap: 500ms → 3ms (**165x faster**)
- Watchlist defaults: 227ms → <1ms (**227x+ faster**)

**Refresh Strategy:**
```sql
-- Called after daily sync
SELECT refresh_all_materialized_views();

-- Or individually
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
```

---

## 5. API Surface

### Shorts API (ShortedStocksService)

#### Public Endpoints (No auth required)

| RPC | HTTP Equivalent | Description |
|-----|----------------|-------------|
| `GetTopShorts` | GET /v1/shorts/top | Paginated top shorted stocks |
| `GetStock` | GET /v1/stocks/{code} | Stock summary |
| `GetStockDetails` | GET /v1/stocks/{code}/details | Full metadata |
| `GetStockData` | GET /v1/stocks/{code}/data | Historical time series |
| `GetIndustryTreeMap` | GET /v1/treemap | Sector heatmap |
| `SearchStocks` | GET /v1/search | Full-text search |

#### Authenticated Endpoints

| RPC | Required Role | Description |
|-----|---------------|-------------|
| `MintToken` | user | Generate API token |
| `GetMySubscription` | user | User's subscription status |

#### Admin Endpoints

| RPC | Required Role | Description |
|-----|---------------|-------------|
| `GetSyncStatus` | admin | Sync job monitoring |
| `SyncKeyMetrics` | admin | Trigger Yahoo Finance sync |
| `EnrichStock` | admin | Trigger GPT-4 enrichment |
| `GetTopStocksForEnrichment` | admin | Prioritized enrichment candidates |
| `ListPendingEnrichments` | admin | Review queue |
| `GetPendingEnrichment` | admin | Single enrichment details |
| `ReviewEnrichment` | admin | Approve/reject enrichment |
| `GetEnrichmentJobStatus` | admin | Job tracking |
| `ListEnrichmentJobs` | admin | Job history |

### Market Data API (MarketDataService)

| RPC | Description |
|-----|-------------|
| `GetStockPrice` | Latest price for a stock |
| `GetHistoricalPrices` | OHLCV time series |
| `GetMultipleStockPrices` | Batch price lookup |
| `GetStockCorrelations` | Correlation matrix |

### Dashboard API (DEFINED BUT NOT IMPLEMENTED)

Proto exists at `proto/shortedapi/dashboard/v1/dashboard.proto` but backend implementation is missing. Frontend uses localStorage instead.

---

## 6. Authentication & Authorization

### Authentication Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    USER AUTHENTICATION FLOW                       │
└──────────────────────────────────────────────────────────────────┘

1. User clicks "Sign In"
         │
         ▼
2. NextAuth.js redirects to /api/auth/signin
         │
         ▼
3. Firebase Auth (Google OAuth provider)
         │
         ▼
4. User authenticates with Google account
         │
         ▼
5. Firebase returns ID token
         │
         ▼
6. NextAuth.js creates session (JWT in httpOnly cookie)
         │
         ▼
7. Frontend stores user state in React context
```

### Service-to-Service Authentication

```typescript
// web/src/server/apiClient.ts
async function getAuthHeaders(): Promise<Record<string, string>> {
  // Production: Google ID Token
  if (isGoogleAuthAvailable()) {
    const idToken = await getGoogleIdToken();
    return { Authorization: `Bearer ${idToken}` };
  }

  // Development: Internal secret
  if (process.env.NODE_ENV === 'development') {
    return { 'X-Internal-Secret': 'dev-internal-secret' };
  }
}
```

### Authorization Middleware (Backend)

```go
// services/shorts/internal/services/shorts/middleware_connect.go

// Public endpoints: No auth required
// User endpoints: Valid session required
// Admin endpoints: Email in admin list required

adminEmails := []string{
    "e2e-test@shorted.com.au",  // TODO: Remove from production
    "ben.ebsworth@gmail.com",
    "ben@shorted.com.au",
}
```

### Stripe Webhook Authentication

```typescript
// web/src/app/api/stripe/webhook/route.ts
const signature = headersList.get("stripe-signature");
const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
// Then call Shorts API with X-Internal-Secret
```

---

## 7. Frontend Architecture

### Directory Structure

```
web/src/
├── app/                      # Next.js App Router
│   ├── page.tsx             # Homepage
│   ├── shorts/[stockCode]/  # Stock detail pages
│   ├── dashboards/          # User dashboards
│   ├── admin/               # Admin panel
│   ├── api/                 # API routes
│   │   └── stripe/          # Stripe webhooks
│   └── actions/             # Server Actions
│
├── @/                        # Aliased imports (shadcn pattern)
│   ├── components/
│   │   ├── ui/              # Base UI components (shadcn)
│   │   ├── widgets/         # Dashboard widgets
│   │   └── dashboard/       # Dashboard-specific components
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Utilities
│   │   ├── client-api.ts    # Client-side API calls
│   │   ├── firebase-client.ts
│   │   ├── widget-registry.ts
│   │   └── dashboard-service-local.ts
│   └── types/               # TypeScript types
│
├── server/                   # Server-only code
│   ├── apiClient.ts         # Authenticated API client
│   ├── auth.ts              # NextAuth configuration
│   └── getGoogleIdToken.ts
│
└── gen/                      # Generated protobuf types
    ├── shorts/v1alpha1/
    ├── stocks/v1alpha1/
    └── marketdata/v1/
```

### Data Fetching Patterns

| Context | Pattern | Example |
|---------|---------|---------|
| Server Component | Server Action with `cache()` | `getTopShorts()` |
| Client Component | React Query | `useQuery(['stock', code], fetchStock)` |
| Search | Algolia InstantSearch | `<InstantSearch indexName="stocks">` |
| User Data | Firestore | `doc(firestore, 'portfolios', userId)` |
| Dashboard | localStorage | `dashboardServiceLocal.saveDashboard()` |

### Widget System

```typescript
// web/src/@/lib/widget-registry.ts
export const widgetRegistry = new WidgetRegistry();

// Widget types:
// - TOP_SHORTS: Top shorted stocks list
// - WATCHLIST: Custom stock watchlist
// - INDUSTRY_TREEMAP: Sector heatmap
// - STOCK_CHART: Price + shorts chart
// - TIME_SERIES: Historical data chart
// - MARKET_WATCHLIST: Default watchlist

// Dynamic loading:
const Component = await widgetRegistry.getComponent(widget.type);
```

### State Management

- **Server State**: React Query (TanStack Query)
- **UI State**: React useState/useReducer + Jotai (atoms)
- **Form State**: React Hook Form + Zod validation
- **Dashboard State**: useAutoSave + useUndoRedo hooks

---

## 8. Infrastructure & Deployment

### Environments

| Environment | Trigger | GCP Project | Frontend |
|-------------|---------|-------------|----------|
| Development | Local | - | localhost:3020 |
| Preview | Pull Request | `shorted-dev-aba5688f` | Vercel PR deploy |
| Production | GitHub Release | `rosy-clover-477102-t5` | shorted.com.au |

### Terraform Structure

```
terraform/
├── environments/
│   ├── dev/
│   │   ├── main.tf        # Dev infrastructure
│   │   ├── variables.tf   # Dev variables
│   │   └── backend.tf     # State storage (local - should be GCS)
│   └── prod/
│       └── ...
└── modules/
    ├── shorts-api/        # Shorts API Cloud Run
    ├── enrichment-processor/
    ├── market-discovery-sync/
    ├── preview/           # PR preview environments
    └── ...
```

### CI/CD Pipeline

```yaml
# .github/workflows/terraform-deploy.yml
# Triggered on: push to main, PR, release

Steps:
1. Authenticate to GCP (Workload Identity Federation)
2. Build Docker images
3. Push to Artifact Registry
4. Run Terraform plan
5. Apply Terraform (main branch only)
6. Deploy frontend to Vercel
7. Run E2E tests (Playwright)
8. Comment results on PR
```

### Docker Images

| Image | Base | Size | Notes |
|-------|------|------|-------|
| shorts | golang:1.23-alpine + alpine | ~50MB | Multi-stage build |
| market-data | golang:1.23-alpine + alpine | ~50MB | Multi-stage build |
| enrichment-processor | python:3.11-slim | ~1.5GB | ML models included |

---

## 9. External Integrations

### Integration Map

```
┌────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                          │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  DATA SOURCES                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │    ASIC     │  │   Yahoo     │  │   OpenAI    │            │
│  │  (CSV/Web)  │  │  Finance    │  │   GPT-4     │            │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
│         │                │                │                    │
│         └────────────────┼────────────────┘                    │
│                          │                                     │
│  AUTH & USERS            │                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  Firebase   │  │   Google    │  │  Firestore  │            │
│  │    Auth     │  │   OAuth     │  │ (User Data) │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│                                                                 │
│  PAYMENTS                                                       │
│  ┌─────────────────────────────────────────────┐               │
│  │              Stripe                          │               │
│  │  • Checkout Sessions                         │               │
│  │  • Customer Portal                           │               │
│  │  • Webhooks → /api/stripe/webhook           │               │
│  └─────────────────────────────────────────────┘               │
│                                                                 │
│  SEARCH                                                         │
│  ┌─────────────────────────────────────────────┐               │
│  │              Algolia                         │               │
│  │  • Index: stocks (~4.5K records)            │               │
│  │  • App ID: 1BWAPWSTDD                       │               │
│  └─────────────────────────────────────────────┘               │
│                                                                 │
│  CLOUD (GCP)                                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  Cloud Run  │  │    GCS      │  │   Secret    │            │
│  │  (Services) │  │  (Storage)  │  │   Manager   │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Configuration

| Service | Config Location | Notes |
|---------|-----------------|-------|
| Firebase | `web/src/@/lib/firebase-client.ts` | Client SDK config |
| Stripe | `web/src/app/api/stripe/*` | Webhook secret in env |
| Algolia | `services/Makefile`, env vars | App ID, API keys |
| Supabase | Terraform variables | Connection pooler on port 6543 |

---

## 10. Known Issues & Technical Debt

### Critical (P0)

1. **Deprecated JWT library** - `github.com/dgrijalva/jwt-go` has CVE-2020-26160
2. **Hardcoded secrets** - Dev secrets in production code paths
3. **Terraform state local** - Should be in GCS with encryption

### High Priority (P1)

4. **panic() in DB init** - Should return errors for graceful handling
5. **MD5 for cache keys** - Collision risk, use SHA-256
6. **No query timeouts** - Many queries use `context.Background()`
7. **Infinite re-render** - Dashboard auto-save callback instability
8. **Memory leaks** - Random tooltip keys, unbounded cleanup goroutines

### Architecture Debt

9. **Dual auth system** - Firebase + NextAuth complexity
10. **Dual database** - PostgreSQL + Firestore for different data
11. **Overlapping sync services** - daily-sync, market-data-sync, asx-discovery
12. **Unused DashboardService proto** - Defined but not implemented
13. **Inconsistent data fetching** - Mix of patterns in frontend

### Missing Capabilities

14. **No observability** - No structured logging, tracing, or APM
15. **No rate limiting** - Public APIs have no throttling
16. **No request ID tracing** - Can't correlate logs across services
17. **No graceful shutdown** - Services don't drain connections

See `TODO.md` for complete prioritized remediation plan.

---

## Appendix: Essential Files Reference

### Backend Core
- `services/shorts/cmd/server/main.go` - Shorts API entry point
- `services/shorts/internal/services/shorts/service.go` - RPC handlers
- `services/shorts/internal/store/shorts/store.go` - Database interface
- `services/market-data/main.go` - Market Data service

### Frontend Core
- `web/src/app/page.tsx` - Homepage
- `web/src/app/shorts/[stockCode]/page.tsx` - Stock detail
- `web/src/server/apiClient.ts` - Server-side API client
- `web/src/@/lib/widget-registry.ts` - Widget system

### Infrastructure
- `terraform/environments/dev/main.tf` - Infrastructure definition
- `.github/workflows/terraform-deploy.yml` - CI/CD pipeline
- `Makefile` - Development orchestration

### API Contracts
- `proto/shortedapi/shorts/v1alpha1/shorts.proto` - Main API
- `proto/shortedtypes/stocks/v1alpha1/stocks.proto` - Shared types
- `proto/marketdata/v1/marketdata.proto` - Market Data API
