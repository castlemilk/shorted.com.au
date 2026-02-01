# Architectural Patterns Reference

**Purpose:** Quick reference for patterns in use across the Shorted.com.au codebase.

---

## Backend Patterns (Go)

### Service Layer Pattern
```go
// services/shorts/internal/services/shorts/service.go
type ShortsServer struct {
    store  ShortsStore    // Interface for database
    cache  Cache          // Interface for caching
    logger Logger         // Interface for logging
    // ...
}

// Constructor with dependency injection
func NewServer(store ShortsStore, cache Cache, opts ...ServerOption) *ShortsServer
```

### Store Interface Pattern
```go
// services/shorts/internal/services/shorts/interfaces.go
type ShortsStore interface {
    GetTopShorts(period string, limit int32, offset int32) ([]*TimeSeriesData, int, error)
    GetStock(productCode string) (*Stock, error)
    // ... 30+ methods
}

// Adapter bridges concrete store to interface
type StoreAdapter struct {
    store shorts.Store
}
```

### Connect-RPC Handler Pattern
```go
func (s *ShortsServer) GetTopShorts(
    ctx context.Context,
    req *connect.Request[pb.GetTopShortsRequest],
) (*connect.Response[pb.GetTopShortsResponse], error) {
    // 1. Validate request
    validation.ValidateRequest(req.Msg)

    // 2. Call store
    data, total, err := s.store.GetTopShorts(...)

    // 3. Return Connect response
    return connect.NewResponse(&pb.GetTopShortsResponse{...}), nil
}
```

### Materialized View with Fallback
```go
// services/shorts/internal/store/shorts/getTopshorts.go
func (s *postgresStore) GetTopShorts(...) {
    // Try MV first (fast: ~6ms)
    result := s.tryMaterializedView()
    if result != nil {
        return result
    }

    // Fallback to raw query (~2300ms)
    return s.fallbackQuery()
}
```

---

## Frontend Patterns (TypeScript/React)

### Server Component Data Fetching
```tsx
// web/src/app/page.tsx
import { cache } from 'react';

const getTopShorts = cache(async () => {
    const client = await createAuthenticatedClient();
    return client.getTopShorts({ limit: 50 });
});

export default async function HomePage() {
    const data = await getTopShorts();
    return <TopShortsTable data={data} />;
}
```

### Server Action Pattern
```tsx
// web/src/app/actions/getTopShorts.ts
'use server';

import { createAuthenticatedClient } from '@/server/apiClient';

export async function getTopShorts(period: string, limit: number) {
    const client = await createAuthenticatedClient();
    return client.getTopShorts({ period, limit });
}
```

### Client-Side Data Fetching
```tsx
// Using React Query
const { data, isLoading } = useQuery({
    queryKey: ['stock', stockCode],
    queryFn: () => fetchStockDataClient(stockCode, period),
});
```

### Widget Registry Pattern
```tsx
// web/src/@/lib/widget-registry.ts
class WidgetRegistry {
    private widgets = new Map<WidgetType, WidgetDefinition>();

    async getComponent(type: WidgetType): Promise<React.ComponentType> {
        const def = this.widgets.get(type);
        return def.component(); // Dynamic import
    }

    getConfigSchema(type: WidgetType): JSONSchema {
        return this.widgets.get(type).configSchema;
    }
}
```

### Auto-Save Hook Pattern
```tsx
// web/src/@/hooks/use-auto-save.ts
export function useAutoSave<T>(options: AutoSaveOptions<T>) {
    const pendingRef = useRef<T | null>(null);
    const [status, setStatus] = useState<SaveStatus>('idle');

    const markPending = useCallback((data: T) => {
        pendingRef.current = data;
        debouncedSave(data);
    }, []);

    const saveNow = useCallback(async () => {
        if (pendingRef.current) {
            await options.onSave(pendingRef.current);
            pendingRef.current = null;
        }
    }, [options.onSave]);

    return { markPending, saveNow, status };
}
```

### Undo/Redo Pattern
```tsx
// web/src/@/hooks/use-undo-redo.ts
interface UndoRedoState<T> {
    past: T[];
    present: T;
    future: T[];
}

const undo = () => {
    if (state.past.length === 0) return;
    setState({
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
    });
};
```

---

## Infrastructure Patterns

### Terraform Module Pattern
```hcl
# terraform/modules/shorts-api/main.tf
resource "google_cloud_run_v2_service" "shorts" {
    name     = "shorts-service"
    location = var.region

    template {
        containers {
            image = var.image_url

            env {
                name = "DATABASE_URL"
                value_source {
                    secret_key_ref {
                        secret  = "DATABASE_URL"
                        version = "latest"
                    }
                }
            }
        }
    }
}
```

### Workload Identity Federation
```yaml
# .github/workflows/terraform-deploy.yml
- id: auth
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
    service_account: ${{ secrets.SA_EMAIL }}
```

### Preview Environment Pattern
```hcl
# terraform/modules/preview/main.tf
locals {
    pr_number = regex(".*-pr-(\\d+)", var.preview_id)
    pr_suffix = "pr-${local.pr_number[0]}"
}

resource "google_cloud_run_v2_service" "shorts_preview" {
    name = "shorts-service-${local.pr_suffix}"
    # Auto-cleanup when PR closes
}
```

---

## Database Patterns

### Materialized View Refresh
```sql
-- Refresh function called after daily sync
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;
END;
$$ LANGUAGE plpgsql;
```

### Covering Index Pattern
```sql
-- Index includes all columns needed by query
CREATE INDEX idx_shorts_timeseries_covering
ON shorts ("PRODUCT_CODE", "DATE" DESC)
INCLUDE ("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");
```

### JSONB Key Metrics Pattern
```sql
-- Flexible schema for Yahoo Finance metrics
ALTER TABLE "company-metadata"
ADD COLUMN key_metrics JSONB DEFAULT '{}'::jsonb;

-- Query specific metric
SELECT key_metrics->>'market_cap' as market_cap
FROM "company-metadata"
WHERE stock_code = 'BHP';
```

---

## API Patterns

### Protobuf Service Definition
```protobuf
// proto/shortedapi/shorts/v1alpha1/shorts.proto
service ShortedStocksService {
    rpc GetTopShorts (GetTopShortsRequest) returns (GetTopShortsResponse) {
        option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
        option (gnostic.openapi.v3.operation) = {
            summary: "Get Top Shorts"
            description: "..."
        };
    }
}
```

### Custom Method Options
```protobuf
// proto/shortedapi/options/v1/options.proto
extend google.protobuf.MethodOptions {
    Visibility visibility = 50000;
    string required_role = 50001;
}

enum Visibility {
    VISIBILITY_PUBLIC = 0;
    VISIBILITY_PRIVATE = 1;
}
```

---

## Authentication Patterns

### Server-Side Auth Headers
```typescript
// web/src/server/apiClient.ts
export async function getAuthHeaders(): Promise<Record<string, string>> {
    const session = await auth();
    const headers: Record<string, string> = {};

    // Add user info for authorization
    if (session?.user) {
        headers['X-User-Email'] = session.user.email;
        headers['X-User-Id'] = session.user.id;
    }

    // Production: Google ID token
    if (isGoogleAuthAvailable()) {
        const idToken = await getGoogleIdToken();
        headers['Authorization'] = `Bearer ${idToken}`;
    }

    return headers;
}
```

### Admin Check Middleware
```go
// services/shorts/internal/services/shorts/middleware_connect.go
func (m *AuthMiddleware) checkAdmin(email string) bool {
    adminEmails := []string{
        "ben.ebsworth@gmail.com",
        "ben@shorted.com.au",
    }
    for _, admin := range adminEmails {
        if strings.EqualFold(email, admin) {
            return true
        }
    }
    return false
}
```
