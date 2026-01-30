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
│  Shorts API      │  Market Data     │  Enrichment Processor         │
│  Go (port 9091)  │  Go (port 8090)  │  Go + Python                  │
│  Main API        │  Stock prices    │  GPT-4 enrichment             │
└──────────────────┴──────────────────┴───────────────────────────────┘
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

| Service     | Port | Directory                        | Description                             |
| ----------- | ---- | -------------------------------- | --------------------------------------- |
| Frontend    | 3020 | `web/`                           | Next.js app with dashboard, stock pages |
| Shorts API  | 9091 | `services/shorts/`               | Main API for short position data        |
| Market Data | 8090 | `services/market-data/`          | Historical stock prices                 |
| Enrichment  | -    | `services/enrichment-processor/` | AI-powered company metadata             |
| Daily Sync  | -    | `services/daily-sync/`           | Scheduled data updates                  |

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
```

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

| File                          | Purpose                           |
| ----------------------------- | --------------------------------- |
| `Makefile`                    | Root-level orchestration commands |
| `services/Makefile`           | Backend-specific commands         |
| `web/Makefile`                | Frontend-specific commands        |
| `proto/buf.yaml`              | Protobuf configuration            |
| `terraform/environments/dev/` | Dev infrastructure config         |
| `services/migrations/`        | Database migrations               |

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

## External Services

| Service   | Purpose               | Config Location                    |
| --------- | --------------------- | ---------------------------------- |
| Supabase  | Production PostgreSQL | `web/.env.local`                   |
| Algolia   | Search index          | `services/Makefile`                |
| Firebase  | Authentication        | `web/src/@/lib/firebase-client.ts` |
| GCS       | Logo storage          | Terraform                          |
| Cloud Run | Backend hosting       | Terraform                          |
| Vercel    | Frontend hosting      | `web/vercel.json`                  |

## Git Workflow

```bash
# Before pushing
make test             # Runs full validation

# Or use the hook
make install-hooks    # Sets up pre-push hook
```
