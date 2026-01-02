# API Endpoints

Add new Connect-RPC API endpoints to the Shorted backend. Use when creating new API methods, defining protobuf services, or implementing backend handlers.

## Repository Layout for APIs

```
shorted/
├── proto/                                    # Protobuf definitions (source of truth)
│   ├── buf.yaml                              # Buf configuration
│   ├── buf.gen.yaml                          # Code generation config
│   ├── shortedapi/
│   │   └── shorts/
│   │       └── v1alpha1/
│   │           └── shorts.proto              # Main API definitions
│   ├── shortedtypes/
│   │   └── stocks/
│   │       └── v1alpha1/
│   │           └── stocks.proto              # Shared type definitions
│   └── marketdata/
│       └── v1/
│           └── marketdata.proto              # Market data API
│
├── services/                                 # Go backend
│   ├── gen/proto/go/                         # Generated Go types
│   │   ├── shorts/v1alpha1/                  # Generated shorts API
│   │   └── stocks/v1alpha1/                  # Generated stock types
│   ├── shorts/
│   │   ├── cmd/server/main.go                # Service entry point
│   │   └── internal/
│   │       ├── services/shorts/
│   │       │   ├── service.go                # RPC handlers
│   │       │   └── service_test.go           # Handler tests
│   │       └── store/shorts/
│   │           ├── store.go                  # Store interface
│   │           ├── postgres.go               # PostgreSQL implementation
│   │           └── mocks/mock_store.go       # Generated mocks
│   └── market-data/
│       ├── main.go                           # Market data service
│       └── validation.go
│
└── web/                                      # Next.js frontend
    └── src/gen/                              # Generated TypeScript types
        ├── shorts/v1alpha1/
        │   ├── shorts_pb.ts                  # Message types
        │   └── shorts-ShortedStocksService_connectquery.ts  # React Query hooks
        └── stocks/v1alpha1/
            └── stocks_pb.ts                  # Stock types
```

## Workflow

```
1. Define protobuf  →  2. Generate code  →  3. Add store method  →  4. Implement handler
   (proto/)              (buf generate)      (internal/store/)      (internal/services/)
```

## Instructions

### Step 1: Define Protobuf

Edit `proto/shortedapi/shorts/v1alpha1/shorts.proto`:

```protobuf
service ShortedStocksService {
  rpc GetNewFeature(GetNewFeatureRequest) returns (GetNewFeatureResponse) {
    option (google.api.http) = {
      post: "/v1/newFeature"
      body: "*"
    };
  }
}

message GetNewFeatureRequest {
  string product_code = 1;
  int32 limit = 2;
}

message GetNewFeatureResponse {
  repeated FeatureData data = 1;
}
```

### Step 2: Generate Code

```bash
cd proto && buf generate
```

### Step 3: Add Store Interface

Edit `services/shorts/internal/store/shorts/store.go`:

```go
type Store interface {
    GetNewFeature(productCode string, limit int32) ([]*FeatureData, error)
}
```

### Step 4: Implement Store

Add to `services/shorts/internal/store/shorts/postgres.go`

### Step 5: Implement Handler

Edit `services/shorts/internal/services/shorts/service.go`:

```go
func (s *ShortsService) GetNewFeature(
    ctx context.Context,
    req *connect.Request[shortsv1alpha1.GetNewFeatureRequest],
) (*connect.Response[shortsv1alpha1.GetNewFeatureResponse], error) {
    data, err := s.store.GetNewFeature(req.Msg.ProductCode, req.Msg.Limit)
    if err != nil {
        return nil, connect.NewError(connect.CodeInternal, err)
    }
    return connect.NewResponse(&shortsv1alpha1.GetNewFeatureResponse{Data: data}), nil
}
```

### Step 6: Test

```bash
curl -X POST http://localhost:9091/v1/newFeature \
  -H "Content-Type: application/json" \
  -d '{"product_code": "BHP", "limit": 10}'
```

## Key Files

| Purpose              | Path                                                  |
| -------------------- | ----------------------------------------------------- |
| Main API proto       | `proto/shortedapi/shorts/v1alpha1/shorts.proto`       |
| Shared types proto   | `proto/shortedtypes/stocks/v1alpha1/stocks.proto`     |
| Buf config           | `proto/buf.yaml`, `proto/buf.gen.yaml`                |
| Store interface      | `services/shorts/internal/store/shorts/store.go`      |
| Store implementation | `services/shorts/internal/store/shorts/postgres.go`   |
| Service handler      | `services/shorts/internal/services/shorts/service.go` |
| Generated Go types   | `services/gen/proto/go/shorts/v1alpha1/`              |
| Generated TS types   | `web/src/gen/shorts/v1alpha1/`                        |

## Proto Conventions

- Use `snake_case` for field names (auto-converts to camelCase in JS)
- Always add `google.api.http` option for REST compatibility
- Define shared types in `shortedtypes/` for reuse across services
- Use `v1alpha1` for unstable APIs, `v1` for stable APIs
- Run `cd proto && buf lint` to check proto style

## Frontend Usage

Generated hooks work with TanStack Query:

```typescript
import { useQuery } from "@connectrpc/connect-query";
import { getTopShorts } from "~/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery";

export function useTopShorts(period: string) {
  return useQuery(getTopShorts, { period, limit: 10 });
}
```
