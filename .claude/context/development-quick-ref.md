# Development Quick Reference

**Purpose:** Fast lookup for common development tasks.

---

## Local Development

### Start Everything
```bash
make dev           # Database + Backend + Frontend
make dev-stop      # Stop all services
```

### Start Services Individually
```bash
make dev-db        # PostgreSQL on port 5438
make dev-backend   # Shorts API on port 9091
make dev-frontend  # Next.js on port 3020
```

### Database Access
```
Host: localhost:5438
Database: shorts
Username: admin
Password: password
Connection: postgresql://admin:password@localhost:5438/shorts
```

### Production Database (Supabase)
```
Host: aws-0-ap-southeast-2.pooler.supabase.com
Port: 6543 (transaction pooler)
Database: postgres
Username: postgres.xivfykscsdagwsreyqgf
```

---

## Testing

```bash
make test                    # All tests
make test-frontend           # Jest tests
make test-backend            # Go tests
make test-integration-local  # Integration with Docker
cd web && npm run test:e2e   # Playwright E2E
```

---

## Database Migrations

```bash
cd services
make migrate-create NAME=add_users_table  # Create migration
make migrate-up                           # Apply pending
make migrate-down                         # Rollback one
make migrate-version                      # Current version
```

---

## Protobuf Generation

```bash
cd proto
buf generate                    # Generate all
buf lint                        # Lint protos
buf breaking --against '.git#branch=main'  # Check breaking changes
```

Generated code locations:
- Go: `services/gen/proto/go/`
- TypeScript: `web/src/gen/`

---

## Adding New API Endpoint

1. **Define in proto** (`proto/shortedapi/shorts/v1alpha1/shorts.proto`):
```protobuf
rpc GetNewThing(GetNewThingRequest) returns (GetNewThingResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
}
```

2. **Generate code**:
```bash
cd proto && buf generate
```

3. **Implement handler** (`services/shorts/internal/services/shorts/service.go`):
```go
func (s *ShortsServer) GetNewThing(
    ctx context.Context,
    req *connect.Request[pb.GetNewThingRequest],
) (*connect.Response[pb.GetNewThingResponse], error) {
    // Implementation
}
```

4. **Add store method** (`services/shorts/internal/store/shorts/store.go`)

5. **Frontend types auto-generated** in `web/src/gen/`

---

## Adding New React Component

1. **Location**: `web/src/@/components/` (or `ui/` for base components)

2. **Pattern**:
```tsx
"use client"; // Only if client-side interactivity needed

import { cn } from "@/lib/utils";

interface MyComponentProps {
    className?: string;
}

export function MyComponent({ className }: MyComponentProps) {
    return <div className={cn("base-styles", className)}>...</div>;
}
```

3. **For shadcn components**: Use `npx shadcn-ui@latest add [component]`

---

## Adding New Dashboard Widget

1. **Define widget type** (`web/src/@/types/dashboard.ts`):
```typescript
export enum WidgetType {
    // ... existing
    MY_NEW_WIDGET = "my_new_widget",
}
```

2. **Create widget component** (`web/src/@/components/widgets/my-new-widget.tsx`)

3. **Register in widget-registry** (`web/src/@/lib/widget-registry.ts`):
```typescript
this.widgets.set(WidgetType.MY_NEW_WIDGET, {
    type: WidgetType.MY_NEW_WIDGET,
    name: "My New Widget",
    description: "...",
    component: () => import("@/components/widgets/my-new-widget"),
    configSchema: {...},
    defaultConfig: {...},
});
```

---

## Data Population

```bash
make populate-data        # Full ASIC + prices download
make populate-data-quick  # Use existing CSV files

# Stock price backfill
cd services && make history.stock-data.backfill
```

---

## Refreshing Materialized Views

```sql
-- After data sync
SELECT refresh_all_materialized_views();

-- Individual refresh
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
```

---

## Git Workflow

```bash
git checkout -b feature/my-feature
# Make changes
make test                # Validate before push
git push -u origin feature/my-feature
# Create PR → Preview environment auto-deploys
```

---

## Common File Locations

| What | Where |
|------|-------|
| Main API entry | `services/shorts/cmd/server/main.go` |
| RPC handlers | `services/shorts/internal/services/shorts/service.go` |
| Database layer | `services/shorts/internal/store/shorts/postgres.go` |
| Auth middleware | `services/shorts/internal/services/shorts/middleware_connect.go` |
| Frontend homepage | `web/src/app/page.tsx` |
| Stock detail page | `web/src/app/shorts/[stockCode]/page.tsx` |
| Server API client | `web/src/server/apiClient.ts` |
| Widget registry | `web/src/@/lib/widget-registry.ts` |
| Dashboard page | `web/src/app/dashboards/page.tsx` |
| Terraform main | `terraform/environments/dev/main.tf` |
| CI/CD pipeline | `.github/workflows/terraform-deploy.yml` |

---

## Environment Variables

### Frontend (web/.env.local)
```bash
NEXT_PUBLIC_API_URL=http://localhost:9091
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_ALGOLIA_APP_ID=1BWAPWSTDD
NEXT_PUBLIC_ALGOLIA_SEARCH_KEY=...
AUTH_SECRET=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

### Backend (services/.env)
```bash
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_ADMIN_KEY=...
OPENAI_API_KEY=...
```

---

## Debugging

### Backend not starting?
```bash
make clean-ports   # Kill stale processes
make dev-stop && make dev
```

### Database connection issues?
```bash
make dev-db        # Ensure DB is running
docker ps          # Check container status
```

### Frontend build errors?
```bash
make clean-cache   # Clear Next.js cache
cd web && rm -rf node_modules && npm install
```

### Check service logs
```bash
# Development
docker logs shorted-db  # Database logs
# Production
gcloud run logs read shorts-service --region=australia-southeast2
```

---

## Performance Benchmarks

| Query | Without MV | With MV | Improvement |
|-------|-----------|---------|-------------|
| GetTopShorts (50 stocks) | ~2,300ms | ~6ms | **380x** |
| GetIndustryTreeMap | ~500ms | ~3ms | **165x** |
| Watchlist defaults | ~227ms | <1ms | **227x+** |
| Time series (5 stocks, 6mo) | ~140ms | ~140ms | Raw query |
