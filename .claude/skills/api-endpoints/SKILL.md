---
name: api-endpoints
description: Add new Connect-RPC API endpoints to the shorts backend. Use when creating new API methods, defining protobuf services, or implementing backend handlers.
allowed-tools: Read, Write, Bash(buf:*), Bash(make:*), Grep, Glob
---

# Adding API Endpoints

This skill guides you through adding new Connect-RPC endpoints to the Shorted backend.

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

## Workflow Overview

```
1. Define protobuf  →  2. Generate code  →  3. Add store method  →  4. Implement handler
   (proto/)              (buf generate)      (internal/store/)      (internal/services/)
```

## Step 1: Define the Protobuf

Edit `proto/shortedapi/shorts/v1alpha1/shorts.proto`:

```protobuf
// Add the RPC method to the service
service ShortedStocksService {
  // ... existing methods ...

  rpc GetNewFeature(GetNewFeatureRequest) returns (GetNewFeatureResponse) {
    option (google.api.http) = {
      post: "/v1/newFeature"
      body: "*"
    };
  }
}

// Define request message
message GetNewFeatureRequest {
  string product_code = 1;
  int32 limit = 2;
}

// Define response message
message GetNewFeatureResponse {
  repeated FeatureData data = 1;
  int32 total_count = 2;
}
```

### Protobuf Conventions

- Use `snake_case` for field names (auto-converts to camelCase in generated code)
- Always include `google.api.http` option for REST compatibility
- Group related fields in nested messages
- Use `repeated` for lists, `optional` for nullable fields

## Step 2: Generate Code

```bash
cd proto && buf generate
```

This generates:

- Go types in `services/gen/proto/go/shorts/v1alpha1/`
- TypeScript types in `web/src/gen/`

## Step 3: Add Store Interface Method

Edit `services/shorts/internal/store/shorts/store.go`:

```go
type Store interface {
    // ... existing methods ...

    // GetNewFeature retrieves feature data for a stock
    GetNewFeature(productCode string, limit int32) ([]*FeatureData, error)
}
```

## Step 4: Implement Store Method

Add implementation in `services/shorts/internal/store/shorts/postgres.go`:

```go
func (s *postgresStore) GetNewFeature(productCode string, limit int32) ([]*FeatureData, error) {
    query := `
        SELECT column1, column2
        FROM your_table
        WHERE product_code = $1
        LIMIT $2
    `

    rows, err := s.pool.Query(context.Background(), query, productCode, limit)
    if err != nil {
        return nil, fmt.Errorf("failed to query feature data: %w", err)
    }
    defer rows.Close()

    var results []*FeatureData
    for rows.Next() {
        var item FeatureData
        if err := rows.Scan(&item.Column1, &item.Column2); err != nil {
            return nil, fmt.Errorf("failed to scan row: %w", err)
        }
        results = append(results, &item)
    }

    return results, nil
}
```

## Step 5: Implement Service Handler

Edit `services/shorts/internal/services/shorts/service.go`:

```go
func (s *ShortsService) GetNewFeature(
    ctx context.Context,
    req *connect.Request[shortsv1alpha1.GetNewFeatureRequest],
) (*connect.Response[shortsv1alpha1.GetNewFeatureResponse], error) {
    // Validate input
    if req.Msg.ProductCode == "" {
        return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("product_code is required"))
    }

    // Call store
    data, err := s.store.GetNewFeature(req.Msg.ProductCode, req.Msg.Limit)
    if err != nil {
        s.log.Errorf("failed to get feature: %v", err)
        return nil, connect.NewError(connect.CodeInternal, err)
    }

    return connect.NewResponse(&shortsv1alpha1.GetNewFeatureResponse{
        Data:       data,
        TotalCount: int32(len(data)),
    }), nil
}
```

## Step 6: Add Tests

Create mock expectations in `services/shorts/internal/services/shorts/service_test.go`:

```go
func TestGetNewFeature(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockStore := mocks.NewMockStore(ctrl)
    mockStore.EXPECT().
        GetNewFeature("BHP", int32(10)).
        Return([]*FeatureData{{...}}, nil)

    svc := NewShortsService(mockStore, log.NewLogger())

    resp, err := svc.GetNewFeature(context.Background(),
        connect.NewRequest(&shortsv1alpha1.GetNewFeatureRequest{
            ProductCode: "BHP",
            Limit:       10,
        }))

    require.NoError(t, err)
    assert.Len(t, resp.Msg.Data, 1)
}
```

## Testing the Endpoint

```bash
# Start the backend
make dev-backend

# Test with curl
curl -X POST http://localhost:9091/v1/newFeature \
  -H "Content-Type: application/json" \
  -d '{"product_code": "BHP", "limit": 10}'
```

## Frontend Usage

The generated TypeScript types are in `web/src/gen/`. Use with Connect-Query:

```typescript
import { useQuery } from "@connectrpc/connect-query";
import { getNewFeature } from "~/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery";

export function useNewFeature(productCode: string) {
  return useQuery(getNewFeature, { productCode, limit: 10 });
}
```
