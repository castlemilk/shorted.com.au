---
name: testing
description: Run and write tests for the Shorted project. Use when running tests, writing unit tests, integration tests, or E2E tests.
allowed-tools: Read, Write, Bash(make:*), Bash(go:*), Bash(npm:*), Bash(npx:*), Grep, Glob
---

# Testing Guide

This skill helps you run and write tests for the Shorted project.

## Quick Reference

```bash
# Run all tests (recommended before pushing)
make test

# Frontend tests only
make test-frontend

# Backend tests only
make test-backend

# Integration tests (requires Docker)
make test-integration-local

# E2E tests
cd web && npm run test:e2e
```

## Test Structure

```
shorted/
├── web/
│   ├── src/@/components/ui/__tests__/  # Component unit tests
│   ├── src/@/lib/__tests__/            # Library unit tests
│   ├── src/__tests__/                  # App-level tests
│   └── e2e/                            # Playwright E2E tests
├── services/
│   ├── shorts/internal/services/shorts/  # Service tests (*_test.go)
│   ├── shorts/internal/store/shorts/     # Store tests (*_test.go)
│   └── test/integration/                 # Integration tests
└── test/
    └── integration/                      # Full-stack integration tests
```

## Backend Testing (Go)

### Unit Test Pattern

```go
// services/shorts/internal/services/shorts/service_test.go
package shorts

import (
    "context"
    "testing"

    "connectrpc.com/connect"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "go.uber.org/mock/gomock"
    
    shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
    "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts/mocks"
    "github.com/castlemilk/shorted.com.au/services/pkg/log"
)

func TestGetStock(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    // Create mock store
    mockStore := mocks.NewMockStore(ctrl)
    
    // Set up expectations
    expectedStock := &stockv1alpha1.Stock{
        ProductCode: "BHP",
        Name:        "BHP Group Limited",
    }
    mockStore.EXPECT().
        GetStock("BHP").
        Return(expectedStock, nil)

    // Create service with mock
    svc := NewShortsService(mockStore, log.NewLogger())

    // Execute
    resp, err := svc.GetStock(context.Background(),
        connect.NewRequest(&shortsv1alpha1.GetStockRequest{
            ProductCode: "BHP",
        }))

    // Assert
    require.NoError(t, err)
    assert.Equal(t, "BHP", resp.Msg.Stock.ProductCode)
    assert.Equal(t, "BHP Group Limited", resp.Msg.Stock.Name)
}

func TestGetStock_NotFound(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockStore := mocks.NewMockStore(ctrl)
    mockStore.EXPECT().
        GetStock("INVALID").
        Return(nil, errors.New("stock not found"))

    svc := NewShortsService(mockStore, log.NewLogger())

    _, err := svc.GetStock(context.Background(),
        connect.NewRequest(&shortsv1alpha1.GetStockRequest{
            ProductCode: "INVALID",
        }))

    require.Error(t, err)
    assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}
```

### Table-Driven Tests

```go
func TestGetTopShorts(t *testing.T) {
    tests := []struct {
        name      string
        period    string
        limit     int32
        wantLen   int
        wantError bool
    }{
        {
            name:    "1 month period",
            period:  "1m",
            limit:   10,
            wantLen: 10,
        },
        {
            name:    "3 month period",
            period:  "3m",
            limit:   5,
            wantLen: 5,
        },
        {
            name:      "invalid period",
            period:    "invalid",
            limit:     10,
            wantError: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            ctrl := gomock.NewController(t)
            defer ctrl.Finish()

            mockStore := mocks.NewMockStore(ctrl)
            // Set up expectations based on test case...

            svc := NewShortsService(mockStore, log.NewLogger())
            resp, err := svc.GetTopShorts(context.Background(),
                connect.NewRequest(&shortsv1alpha1.GetTopShortsRequest{
                    Period: tt.period,
                    Limit:  tt.limit,
                }))

            if tt.wantError {
                require.Error(t, err)
                return
            }

            require.NoError(t, err)
            assert.Len(t, resp.Msg.Stocks, tt.wantLen)
        })
    }
}
```

### Generating Mocks

```bash
# Install mockgen (if not installed)
go install go.uber.org/mock/mockgen@latest

# Generate mocks for a store interface
mockgen -source=services/shorts/internal/store/shorts/store.go \
  -destination=services/shorts/internal/store/shorts/mocks/mock_store.go \
  -package=mocks
```

### Running Backend Tests

```bash
# All backend tests
make test-backend

# Specific package
cd services && go test -v ./shorts/internal/services/shorts/...

# With coverage
cd services && go test -v -coverprofile=coverage.out ./...
cd services && go tool cover -html=coverage.out -o coverage.html
```

## Frontend Testing (Jest)

### Component Test Pattern

```tsx
// web/src/@/components/ui/__tests__/sparkline.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { Sparkline, SparklineData } from "../sparkline";

const mockData: SparklineData[] = [
  { date: new Date("2024-01-01"), value: 100 },
  { date: new Date("2024-01-02"), value: 105 },
  { date: new Date("2024-01-03"), value: 102 },
];

describe("Sparkline", () => {
  it("renders without crashing", () => {
    render(<Sparkline data={mockData} width={200} height={50} />);
    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("returns null for insufficient data", () => {
    const { container } = render(
      <Sparkline data={[mockData[0]!]} width={200} height={50} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("uses correct color for positive trend", () => {
    render(<Sparkline data={mockData} width={200} height={50} isPositive />);
    // Check for emerald color class or style
  });

  it("uses correct color for negative trend", () => {
    render(
      <Sparkline data={mockData} width={200} height={50} isPositive={false} />
    );
    // Check for red color class or style
  });

  it("calls onHover callback", () => {
    const onHover = jest.fn();
    render(
      <Sparkline data={mockData} width={200} height={50} onHover={onHover} />
    );
    
    const svg = document.querySelector("svg")!;
    fireEvent.mouseMove(svg);
    
    expect(onHover).toHaveBeenCalled();
  });
});
```

### Hook Test Pattern

```tsx
// web/src/@/hooks/__tests__/use-stock-data.test.ts
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useStockData } from "../use-stock-data";

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe("useStockData", () => {
  it("fetches stock data successfully", async () => {
    const { result } = renderHook(() => useStockData("BHP"), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBeDefined();
    expect(result.current.data?.productCode).toBe("BHP");
  });
});
```

### Running Frontend Tests

```bash
# All frontend tests
make test-frontend

# Watch mode
cd web && npm run test:watch

# With coverage
cd web && npm run test:coverage

# Specific test file
cd web && npm test -- sparkline.test.tsx
```

## Integration Tests

Integration tests use testcontainers to spin up real PostgreSQL:

```go
// test/integration/topshorts_test.go
func TestGetTopShortsIntegration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }

    // Setup testcontainer
    ctx := context.Background()
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:15"),
        postgres.WithDatabase("shorts"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    require.NoError(t, err)
    defer pgContainer.Terminate(ctx)

    // Get connection string
    connStr, err := pgContainer.ConnectionString(ctx)
    require.NoError(t, err)

    // Run migrations and seed data...
    
    // Test actual API calls
}
```

Run integration tests:

```bash
# Requires Docker
make test-integration-local
```

## E2E Tests (Playwright)

### Writing E2E Tests

```typescript
// web/e2e/homepage.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Homepage", () => {
  test("displays top shorted stocks", async ({ page }) => {
    await page.goto("/");
    
    // Wait for data to load
    await expect(page.getByTestId("top-shorts-list")).toBeVisible();
    
    // Check that stocks are displayed
    const stockItems = page.getByTestId("stock-item");
    await expect(stockItems).toHaveCount(10);
  });

  test("navigates to stock detail page", async ({ page }) => {
    await page.goto("/");
    
    // Click on first stock
    await page.getByTestId("stock-item").first().click();
    
    // Verify navigation
    await expect(page).toHaveURL(/\/stocks\/.+/);
    await expect(page.getByTestId("stock-header")).toBeVisible();
  });
});
```

### Running E2E Tests

```bash
# Run all E2E tests
cd web && npm run test:e2e

# Run with UI
cd web && npm run test:e2e:ui

# Debug mode
cd web && npm run test:e2e:debug

# View report
cd web && npm run test:e2e:report
```

## Pre-Push Validation

Always run the full test suite before pushing:

```bash
make test
```

This runs:
1. TypeScript + Go linting
2. Frontend build (type checking)
3. Frontend unit tests (Jest)
4. Backend unit tests (Go)
5. Integration tests (if Docker available)

