# Shorted.com.au

A platform for tracking short selling positions in the Australian stock market, providing real-time data from ASIC and comprehensive company analytics.

## Quick Start

```bash
# Install dependencies
make install

# Start all services (database + backend + frontend)
make dev

# Visit http://localhost:3020
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
│                    Next.js 14 (Vercel) - Port 3020                      │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
┌───────────────────▼───────────┐   ┌───────────────────▼───────────┐
│       Shorts API              │   │     Enrichment Processor      │
│   Go + Connect-RPC - 9091     │   │     Python/Go - Cloud Run     │
└───────────────────┬───────────┘   └───────────────────────────────┘
                    │
          ┌────────┴────────┐
          │                 │
┌─────────▼─────────┐  ┌────▼────┐
│    PostgreSQL     │  │ Algolia │
│    (Supabase)     │  │ Search  │
└───────────────────┘  └─────────┘
```

## Services

| Service | Port | Description | Command |
|---------|------|-------------|---------|
| Frontend | 3020 | Next.js web application | `make dev-frontend` |
| Shorts API | 9091 | Short position data API (Connect-RPC) | `make dev-backend` |
| Database | 5438 | PostgreSQL (local Docker) | `make dev-db` |
| Enrichment | - | Company metadata enrichment | `make dev-enrichment-processor` |

## Development

### Prerequisites

- Node.js 20+
- Go 1.23+
- Docker & Docker Compose
- (Optional) Stripe CLI for payment testing

### Commands

```bash
# Development
make dev                  # Start all services
make dev-frontend         # Frontend only
make dev-backend          # Backend only
make dev-db               # Database only
make dev-stop             # Stop all services
make clean-ports          # Kill stale processes

# Testing
make test                 # Run all tests (lint + unit + integration)
make test-frontend        # Frontend tests only
make test-backend         # Backend tests only
make test-integration     # Integration tests with testcontainers

# Database
make populate-data        # Download and populate ASIC short data
make db-diagnose          # Diagnose query performance
make db-optimize          # Apply performance indexes

# Code Quality
make lint                 # Run linting (TypeScript + Go)
make format               # Format all code
```

### Local Database

```
Host:     localhost:5438
Database: shorts
Username: admin
Password: password
```

## Project Structure

```
shorted/
├── web/                    # Next.js frontend
│   ├── src/app/           # App router pages
│   ├── src/@/components/  # Shared components (shadcn)
│   └── src/gen/           # Generated protobuf types
├── services/              # Go backend services
│   ├── shorts/            # Main API service
│   ├── enrichment-processor/  # Company enrichment
│   ├── daily-sync/        # ASIC data sync job
│   └── migrations/        # Database migrations
├── proto/                 # Protobuf API definitions
├── terraform/             # Infrastructure as code
│   ├── environments/      # dev, prod configs
│   └── modules/           # Reusable modules
├── analysis/              # Python data analysis scripts
└── docs/                  # Documentation
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, TypeScript, TailwindCSS, Radix UI |
| Backend | Go 1.23, Connect-RPC (gRPC-Web) |
| Database | PostgreSQL (Supabase), Firestore (user data) |
| Search | Algolia |
| Auth | NextAuth.js v5, Firebase, Google OAuth |
| Payments | Stripe |
| Infrastructure | GCP Cloud Run, Terraform |
| CI/CD | GitHub Actions, Vercel |

## Documentation

| Document | Description |
|----------|-------------|
| [Production Deployment](docs/PRODUCTION_DEPLOYMENT.md) | Deploy to production guide |
| [Terraform Guide](terraform/README.md) | Infrastructure management |
| [API Reference](web/public/docs/api-reference.md) | API documentation |

## Deployment

### Environments

| Environment | Trigger | GCP Project |
|-------------|---------|-------------|
| Preview | Pull Request | `shorted-dev-aba5688f` |
| Dev | Push to `main` | `shorted-dev-aba5688f` |
| Production | GitHub Release | `rosy-clover-477102-t5` |

### Deploy to Production

```bash
# Create release tag
git tag v1.0.0
git push origin v1.0.0

# Create Release in GitHub UI to trigger deployment
```

See [Production Deployment Guide](docs/PRODUCTION_DEPLOYMENT.md) for full details.

## Environment Variables

### Required for Development

```bash
# Database (local)
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts

# Algolia (search)
ALGOLIA_APP_ID=your-app-id
ALGOLIA_SEARCH_KEY=your-search-key

# Auth (optional for local dev)
NEXTAUTH_SECRET=your-secret
AUTH_GOOGLE_ID=your-client-id
AUTH_GOOGLE_SECRET=your-client-secret
```

### Required for Production

See [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md) for full list.

## Contributing

```bash
# 1. Create feature branch
git checkout -b feature/my-feature

# 2. Make changes and test
make test

# 3. Push and create PR
git push origin feature/my-feature
```

## License

Proprietary - All rights reserved.
