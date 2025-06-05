# Shorted.com.au Architecture Documentation

## Overview

Shorted.com.au is a web application for tracking and visualizing short positions on the Australian Stock Exchange (ASX). The system fetches daily short position data from ASIC and presents it through interactive visualizations and analytics.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │     Next.js Frontend (React 18, TypeScript)             │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│  │  │   Pages     │  │  Components  │  │  API Client  │  │  │
│  │  │  - Home     │  │  - Charts    │  │  - Connect   │  │  │
│  │  │  - Stock    │  │  - Tables    │  │  - RPC       │  │  │
│  │  │  - TreeMap  │  │  - Auth      │  │  - Protobuf  │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ├─── NextAuth + Firebase Auth
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Gateway (Connect RPC)                   │
├─────────────────────────────────────────────────────────────────┤
│                        Backend Services                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │  Shorts Service  │  │ Register Service │  │ User Service │ │
│  │  - GetTopShorts  │  │ - RegisterEmail  │  │   (TODO)     │ │
│  │  - GetStock      │  └──────────────────┘  └──────────────┘ │
│  │  - GetTreeMap    │                                          │
│  └──────────────────┘                                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL Database                        │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │    shorts    │  │company-metadata│  │  subscriptions   │  │
│  │  - Daily     │  │  - Company     │  │  - Email         │  │
│  │    positions │  │    details     │  │    subscribers   │  │
│  └──────────────┘  └────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                ▲
                                │
┌─────────────────────────────────────────────────────────────────┐
│                    Data Sync Service (Python)                   │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  - Fetch daily CSV from ASIC                             │ │
│  │  - Process and normalize data                            │ │
│  │  - Store in PostgreSQL                                   │ │
│  │  - Archive to Google Cloud Storage                       │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Frontend
- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **UI**: React 18, Tailwind CSS, Radix UI
- **State**: React Query, Jotai
- **Charts**: Visx (D3.js wrapper)
- **Forms**: React Hook Form + Zod
- **Auth**: NextAuth.js v5

### Backend
- **Language**: Go 1.23
- **API**: Connect RPC (gRPC-compatible)
- **Database**: PostgreSQL (pgx driver)
- **Auth**: Firebase Admin SDK
- **Cloud**: Google Cloud Platform

### Data Pipeline
- **Language**: Python 3
- **Framework**: FastAPI
- **Processing**: Pandas, Dask
- **Storage**: Google Cloud Storage

### Infrastructure
- **Hosting**: Vercel (Frontend), Google Cloud Run (Backend)
- **Database**: Supabase (PostgreSQL)
- **CDN**: Vercel Edge Network
- **Container**: Docker (multi-platform)

## Core Components

### 1. Frontend Application (`/web`)

#### Pages
- **Home** (`/`): Dashboard with top shorts and industry treemap
- **Stock Details** (`/shorts/[stockCode]`): Individual stock analysis
- **Top Shorts View** (`/topShortsView`): Tabular view with sorting/filtering
- **TreeMap** (`/treemap`): Industry-based visualization
- **Blog** (`/blog`): MDX-based content

#### Key Components
- **StockChart**: Time series visualization using Visx
- **DataTable**: Advanced table with sorting, filtering, pagination
- **TreeMap**: D3.js-based hierarchical visualization
- **UserNav**: Authentication and user menu

#### Data Fetching
- Server Components with async data fetching
- Server Actions with caching
- Connect RPC client for API calls

### 2. Backend Services (`/services`)

#### Shorts Service
Handles all stock-related queries:
- `GetTopShorts`: Returns top shorted stocks with sparklines
- `GetStock`: Basic stock information
- `GetStockDetails`: Extended company metadata
- `GetStockData`: Time series data for charts
- `GetIndustryTreeMap`: Hierarchical industry data

#### Register Service
Email subscription management:
- `RegisterEmail`: Subscribe to updates

#### User Service (TODO)
Planned user management:
- User profiles
- Authentication
- Preferences

### 3. Data Sync Service (`/services/short-data-sync`)

Python service that:
1. Downloads daily CSV files from ASIC
2. Detects file encoding
3. Normalizes data format
4. Bulk inserts into PostgreSQL
5. Archives to Google Cloud Storage
6. Handles deduplication

## Database Schema

### shorts table
```sql
CREATE TABLE shorts (
    "Date" DATE,
    "Product Code" TEXT,
    "Product Name" TEXT,
    "Total Product in Issue" BIGINT,
    "Reported Short Positions" BIGINT,
    "% of Total Product in Issue Reported as Short Positions" NUMERIC
);

CREATE INDEX idx_shorts_product_code_date ON shorts ("Product Code", "Date");
CREATE INDEX idx_shorts_date_percent ON shorts ("Date", "% of Total Product in Issue Reported as Short Positions");
```

### company-metadata table
```sql
CREATE TABLE "company-metadata" (
    company_name TEXT,
    address TEXT,
    summary TEXT,
    details TEXT,
    website TEXT,
    stock_code TEXT,
    links TEXT,
    images TEXT,
    company_logo_link TEXT,
    gcs_url TEXT,
    industry TEXT
);
```

### subscriptions table
```sql
CREATE TABLE subscriptions (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Data Flow

1. **Data Ingestion** (Daily)
   - ASIC publishes daily short position CSV
   - Python sync service downloads file
   - Data is processed and loaded into PostgreSQL
   - Raw files archived to GCS

2. **API Request Flow**
   - Client makes request to Next.js app
   - Server component fetches data via Connect RPC
   - Go service queries PostgreSQL
   - Data is transformed and returned
   - Frontend renders visualization

3. **Authentication Flow**
   - User signs in via Google OAuth
   - NextAuth creates session in Firebase
   - Session token sent with API requests
   - Backend validates Firebase token
   - User context added to request

## Security

### Authentication
- NextAuth.js with Firebase adapter
- Google OAuth provider
- JWT session tokens
- Backend token validation

### API Security
- Bearer token authentication
- CORS configuration
- SQL injection prevention (parameterized queries)
- Input validation

### Infrastructure Security
- HTTPS everywhere
- Environment variable management
- Secure secret storage
- Container security scanning

## Performance Optimizations

### Database
- Indexed queries on common patterns
- Connection pooling
- Query result limiting
- Data downsampling for large ranges

### Frontend
- Server-side rendering
- React Server Components
- Code splitting
- Image optimization
- Edge caching

### Backend
- Minimal container images
- Efficient data serialization
- Parallel processing in data sync
- Resource limits on Cloud Run

## Monitoring & Observability

### Current
- Basic error logging
- Cloud Run metrics
- Vercel analytics

### Planned
- Structured logging (Zap)
- Distributed tracing
- Custom metrics
- Error tracking (Sentry)

## Development Workflow

### Local Development
1. Frontend: `npm run dev` in `/web`
2. Backend: `go run` in service directories
3. Database: Local PostgreSQL or Supabase
4. Auth: Firebase emulator

### Code Generation
1. Proto files in `/proto`
2. `buf generate` creates Go and TypeScript types
3. Automatic API client generation

### Deployment
1. Frontend: Auto-deploy to Vercel on push
2. Backend: Manual deploy to Cloud Run
3. Database: Managed by Supabase
4. Data sync: Scheduled Cloud Run job

## Future Enhancements

### High Priority
1. Complete user authentication system
2. Add comprehensive test coverage
3. Implement caching layer (Redis)
4. Add monitoring and alerting

### Medium Priority
1. Real-time data updates
2. Email notifications
3. API rate limiting
4. Mobile app

### Low Priority
1. Historical data analysis
2. Machine learning predictions
3. Social features
4. Premium subscriptions