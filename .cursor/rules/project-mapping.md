# Project Mapping - Core Primitives

Quick reference for navigating and contributing to the Shorted.com.au codebase.

## 1. Protobuf Changes via Buf

### Configuration Files
```
proto/
├── buf.yaml              # Module structure, linting, dependencies
├── buf.gen.yaml          # Full code generation (Go + TypeScript)
├── buf.gen.local.yaml    # Local Go-only generation
└── shortedapi/           # API definitions
    ├── shorts/v1alpha1/shorts.proto      # Main shorts API
    ├── dashboard/v1/dashboard.proto      # Dashboard config
    └── register/v1/register.proto        # Registration
```

### Code Generation Workflow
```bash
# Generate all code (Go + TypeScript)
cd proto && buf generate

# Lint proto files
cd proto && buf lint

# Check breaking changes
cd proto && buf breaking --against '.git#branch=main'
```

### Generated Output Locations
| Language   | Location                                    | Purpose                    |
| ---------- | ------------------------------------------- | -------------------------- |
| Go         | `services/gen/proto/go/`                    | Server types + handlers    |
| TypeScript | `web/src/gen/`                              | Client types               |
| React      | `web/src/gen/**/*_connectquery.ts`          | TanStack Query hooks       |

### Adding a New RPC Endpoint
1. Define in proto file:
   ```protobuf
   rpc GetNewEndpoint(GetNewEndpointRequest) returns (GetNewEndpointResponse) {
     option (google.api.http) = {
       post: "/v1/newEndpoint"
       body: "*"
     };
   }
   ```
2. Run `cd proto && buf generate`
3. Implement handler in `services/shorts/internal/services/shorts/service.go`
4. Add store method in `services/shorts/internal/store/shorts/store.go`
5. Frontend types auto-generated in `web/src/gen/`

---

## 2. GoMock Interface Patterns

### Interface Definition Pattern
Interfaces are defined in dedicated files for mockgen:

```go
// services/shorts/internal/services/shorts/interfaces.go
//go:generate mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks

type ShortsStore interface {
    GetStock(code string) (*Stock, error)
    GetTopShorts(period string, limit, offset int32) ([]*TimeSeriesData, int, error)
    // ... 50+ methods
}

type Cache interface { ... }
type Logger interface { ... }
```

### Key Interface Files
| File                                                   | Interfaces                             |
| ------------------------------------------------------ | -------------------------------------- |
| `services/shorts/internal/services/shorts/interfaces.go` | ShortsStore, Cache, Logger            |
| `services/shorts/internal/services/shorts/gpt_client.go` | GPTClient                             |
| `services/shorts/internal/store/shorts/store.go`        | Store (50+ data access methods)       |

### Generating Mocks
```bash
cd services/shorts/internal/services/shorts
go generate ./...
```

### Mock Usage in Tests
```go
func TestGetTopShorts(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockStore := mocks.NewMockShortsStore(ctrl)
    mockStore.EXPECT().
        GetTopShorts("1M", int32(50), int32(0)).
        Return([]*stocksv1alpha1.TimeSeriesData{...}, 10, nil)

    server := &ShortsServer{store: mockStore}
    // ... test logic
}
```

### Key Test Files
- `services/shorts/internal/services/shorts/service_test.go`
- `services/shorts/internal/services/shorts/enrichment_test.go`
- `services/enrichment-processor/enrichment_processor_test.go`

---

## 3. Sync Job Architecture

### Job Overview
| Job                     | Type          | Schedule           | Purpose                      |
| ----------------------- | ------------- | ------------------ | ---------------------------- |
| `shorts-data-sync`      | Cloud Run Job | Daily 10:00 UTC    | ASIC shorts + prices         |
| `asx-discovery`         | Cloud Run Job | Sunday 12:00 UTC   | ASX stock discovery          |
| `stock-price-ingestion` | HTTP Service  | Mon-Fri 8:00 UTC   | Price updates                |
| `market-data-sync`      | HTTP Service  | Mon-Fri 10:00 UTC  | Market data + gap filling    |

### Key Files
```
services/daily-sync/
├── deprecated/comprehensive_daily_sync.py    # Main Python sync script
├── Dockerfile                                 # Container definition
└── deploy.sh                                  # Deployment script

services/market-data-sync/
├── main.go                                    # Go sync service
├── checkpoint/checkpoint.go                   # Checkpoint management
└── providers/                                 # Yahoo/Alpha Vantage clients
```

### Checkpoint System
The `sync_status` table tracks progress:
```sql
-- Check recent syncs
SELECT run_id, status, started_at,
       checkpoint_stocks_processed, checkpoint_stocks_total
FROM sync_status ORDER BY started_at DESC LIMIT 5;

-- Check for stuck jobs
SELECT * FROM sync_status
WHERE status = 'running' AND started_at < NOW() - INTERVAL '70 minutes';
```

### Manual Triggers
```bash
# Trigger Cloud Run Job
gcloud run jobs execute shorts-data-sync \
  --project=rosy-clover-477102-t5 \
  --region=australia-southeast2

# Trigger via Scheduler
gcloud scheduler jobs run shorts-data-sync-daily \
  --project=rosy-clover-477102-t5 \
  --location=australia-southeast1
```

### Viewing Logs
```bash
# shorts-data-sync logs
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync"' \
  --project=rosy-clover-477102-t5 --limit=50 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity)] \(.textPayload)"'

# Errors only
gcloud logging read 'resource.type="cloud_run_job" AND severity>=ERROR' \
  --project=rosy-clover-477102-t5 --limit=20
```

---

## 4. Infrastructure Layout

### GCP Configuration
| Environment | Project ID               | Region               |
| ----------- | ------------------------ | -------------------- |
| Dev         | `shorted-dev-aba5688f`   | australia-southeast2 |
| Prod        | `rosy-clover-477102-t5`  | australia-southeast2 |

### Terraform Structure
```
terraform/
├── environments/
│   ├── dev/                    # Dev environment
│   └── prod/                   # Production environment
└── modules/
    ├── shorts-api/             # Main API service
    ├── market-data/            # Price service
    ├── short-data-sync/        # Daily sync job
    ├── market-discovery-sync/  # ASX discovery
    ├── enrichment-processor/   # AI enrichment
    └── preview/                # Ephemeral PR environments
```

### Database (Supabase)
- **Project ID**: `xivfykscsdagwsreyqgf`
- **Region**: AWS ap-southeast-2
- **Connection**: Via pooler at `aws-0-ap-southeast-2.pooler.supabase.com:6543`
- **Config**: `supabase/config.toml`

### Service Architecture
```
┌──────────────────────────────────────────────────────────────┐
│                         Vercel                                │
│                    Next.js Frontend (3020)                    │
└─────────────────────────────┬────────────────────────────────┘
                              │ Connect-RPC
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                      Cloud Run Services                       │
├─────────────────┬───────────────────┬────────────────────────┤
│ shorts (9091)   │ market-data (8090)│ enrichment-processor   │
└─────────────────┴───────────────────┴────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    Supabase PostgreSQL                        │
│         (shorts, stock_prices, company_metadata)              │
└──────────────────────────────────────────────────────────────┘
                              ▲
                              │ Daily sync
┌──────────────────────────────────────────────────────────────┐
│                     Cloud Run Jobs                            │
│   (shorts-data-sync, asx-discovery, market-data-sync)         │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. CI/CD Pipeline

### GitHub Actions Workflows
| Workflow                           | Trigger              | Purpose                    |
| ---------------------------------- | -------------------- | -------------------------- |
| `ci.yml`                           | PR, manual           | Tests + E2E               |
| `terraform-deploy.yml`             | PR, push main, release | Full deployment         |
| `algolia-sync.yml`                 | Daily, manual        | Search index sync          |

### Deployment Flow
```
PR Created
    ↓
ci.yml (tests)
    ↓
terraform-deploy.yml
    ├─→ build-and-push-images (7 services)
    ├─→ terraform-plan
    └─→ deploy-preview (ephemeral environment)
         └─→ Comment PR with preview URLs

Push to main / Release
    ↓
terraform-deploy.yml
    ├─→ build-and-push-images
    ├─→ terraform-apply (prod)
    └─→ deploy-vercel-prod
```

### Secrets Management
- **GitHub Secrets** → GitHub Actions
- **Secret Manager** → Cloud Run services
- Key secrets: `DATABASE_URL`, `OPENAI_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `ALGOLIA_*`

### Manual Deployment
```bash
# Deploy via Terraform
cd terraform/environments/prod
terraform init
terraform plan
terraform apply

# Deploy single service
gcloud run deploy shorts \
  --image australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/shorts:latest \
  --region australia-southeast2
```

---

## Quick Reference Commands

### Development
```bash
make dev              # Start all services
make test             # Run all tests
make dev-stop         # Stop services
```

### Proto
```bash
cd proto && buf generate    # Generate code
cd proto && buf lint        # Lint protos
```

### Mocks
```bash
cd services/shorts/internal/services/shorts && go generate ./...
```

### Database
```bash
cd services && make migrate-up      # Apply migrations
cd services && make migrate-down    # Rollback
```

### Sync Jobs
```bash
# Check job status
gcloud run jobs executions list --job=shorts-data-sync \
  --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# View admin dashboard
open https://shorted.com.au/admin
```
