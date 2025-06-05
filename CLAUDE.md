# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shorted.com.au is a web application for tracking and visualizing short positions on the Australian Stock Exchange (ASX). It fetches daily short position data from ASIC and presents it through interactive visualizations and analytics.

## Development Commands

### Frontend (Next.js)
```bash
# Start development server
cd web && npm run dev

# Run tests
cd web && npm test
npm run test:watch    # Watch mode
npm run test:coverage # With coverage

# Build for production
cd web && npm run build

# Lint code
cd web && npm run lint
```

### Backend (Go services)
```bash
# Run shorts service locally
cd services && make run.shorts

# Run tests
cd services && make test
cd services && make test.shorts      # Just shorts service
cd services && make test.coverage    # With coverage report

# Build service
cd services && make build.shorts

# Deploy to Google Cloud Run
cd services && make deploy.gcr.shorts
```

### Root-level commands
```bash
# Run all tests (frontend + backend)
make test

# Install all dependencies
make install

# Start development servers
make dev           # Both frontend and backend
make dev-frontend  # Frontend dev server only (port 3020)
make dev-backend   # Backend dev server only (port 9091)

# Pre-commit checks
make pre-commit    # Format, lint, and test
```

### Database
```bash
# PostgreSQL is hosted on Supabase
# Connection string is in environment variables
# To run locally with Docker:
cd analysis/sql && docker-compose up -d
```

## Architecture Overview

### Tech Stack
- **Frontend**: Next.js 14 (App Router), TypeScript, React 18, Tailwind CSS, Visx (charts)
- **Backend**: Go 1.23, Connect RPC (gRPC-compatible), PostgreSQL
- **Infrastructure**: Google Cloud Run, Vercel, Supabase (PostgreSQL)
- **Data Pipeline**: Python service for syncing ASIC data

### Key Services

1. **Shorts Service** (`services/shorts/`)
   - Main API service handling all stock queries
   - Connect RPC endpoints: GetTopShorts, GetStock, GetStockDetails, GetStockData, GetIndustryTreeMap
   - PostgreSQL queries with pgx driver

2. **Register Service** (`services/register/`)
   - Email subscription management
   - Endpoint: RegisterEmail

3. **Data Sync Service** (`services/short-data-sync/`)
   - Python service that downloads daily CSV files from ASIC
   - Processes and loads data into PostgreSQL
   - Runs as a scheduled job on Google Cloud Run

### Frontend Structure
- **Pages** (`web/src/app/`): Home, Stock Details, TreeMap, Blog
- **Components** (`web/src/components/`): StockChart, DataTable, TreeMap, UserNav
- **Server Actions** (`web/src/app/actions/`): Data fetching functions
- **API Client**: Connect RPC client for backend communication

### API Definition
Protocol Buffers definitions are in `/proto/`:
- `shortedapi/shorts/v1alpha1/shorts.proto` - Main API service
- `shortedapi/register/v1/register.proto` - Email registration
- `shortedtypes/stocks/v1alpha1/stocks.proto` - Shared types

### Code Generation
```bash
# Generate Go and TypeScript types from proto files
cd proto && buf generate
```

## Database Schema

### Main Tables
- **shorts**: Daily short position data (Date, Product Code, Product Name, percentages)
- **company-metadata**: Company details, logos, industry information
- **subscriptions**: Email subscribers

### Key Indexes
- `idx_shorts_product_code_date` - For stock lookups
- `idx_shorts_date_percent` - For top shorts queries
- `idx_metadata_stock_code` - For company metadata joins

## Testing Strategy

### Frontend Testing
- **Unit Tests**: Jest + React Testing Library
- **E2E Tests**: Playwright with cross-browser testing
- **Test files**: `*.test.ts`, `*.test.tsx` (unit), `e2e/*.spec.ts` (E2E)
- **Coverage threshold**: 40% (target: 80%)

### Backend Testing
- **Unit Tests**: Go standard testing package
- **Integration Tests**: Full-stack API testing
- **Test individual services**: `make test.shorts`
- **Integration tests**: `make test.integration`

### Integration Testing
- **Full-stack tests**: Backend + Frontend + Database
- **Docker-based test environment**: Isolated containers
- **API consistency tests**: Cross-endpoint data validation
- **Performance tests**: Response time and concurrency

### Running Tests

#### Unit Tests
```bash
# Frontend unit tests
cd web && npm test
npm run test:watch    # Watch mode
npm run test:coverage # With coverage

# Backend unit tests
cd services && make test
cd services && make test.coverage    # With coverage report
```

#### Integration Tests
```bash
# Full-stack integration tests
make test-integration

# E2E tests with Playwright
make test-e2e
make test-e2e-ui      # With Playwright UI

# All integration tests
make test-all-integration
```

#### Test Environment Management
```bash
# Start test environment
make test-stack-up

# Check test environment status
make test-stack-status

# View test environment logs
make test-stack-logs

# Stop test environment
make test-stack-down
```

#### Individual Test Categories
```bash
# Playwright E2E tests only
cd web && npm run test:e2e
cd web && npm run test:e2e:ui      # With UI
cd web && npm run test:e2e:debug   # Debug mode

# Backend integration tests only
cd test/integration && go test -v ./...

# Specific service tests
make test-shorts
```

## Current Development Focus

The project is currently on the `feature/user-profile-and-login` branch, implementing:
- User authentication with NextAuth.js v5 and Firebase
- User profiles and preferences
- Login/registration flows

## Environment Variables

### Frontend (.env.local)
- `NEXT_PUBLIC_API_URL` - Backend API URL
- `NEXTAUTH_*` - Authentication configuration
- `FIREBASE_*` - Firebase credentials

### Backend
- `APP_STORE_POSTGRES_*` - Database connection
- `GOOGLE_APPLICATION_CREDENTIALS` - GCP service account

## Deployment

### Frontend
- Auto-deploys to Vercel on push to main
- Preview deployments for PRs

### Backend
- Manual deployment to Google Cloud Run
- Docker images pushed to Google Artifact Registry
- Service configuration in `service.template.yaml`

## Important Notes

1. **Authentication**: Currently implementing NextAuth.js v5 with Firebase adapter
2. **Performance**: See OPTIMIZATIONS.md for planned improvements (caching, query optimization)
3. **Testing**: See TEST_STRATEGY.md for comprehensive testing plan
4. **Data Source**: Short position data comes from ASIC daily CSV files
5. **Database**: PostgreSQL hosted on Supabase, avoid direct modifications
6. **Port Configuration**: 
   - Frontend runs on port 3020 (instead of default 3000)
   - Backend runs on port 9091 (instead of default 8080)
   - This prevents conflicts with other local development services