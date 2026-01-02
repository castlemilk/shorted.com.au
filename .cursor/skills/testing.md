# Testing

Run and write tests for the Shorted project. Use when running tests, writing unit tests, integration tests, or E2E tests.

## Quick Commands

```bash
# All tests (recommended before pushing)
make test

# Frontend only
make test-frontend

# Backend only
make test-backend

# Integration tests (requires Docker)
make test-integration-local

# E2E tests
cd web && npm run test:e2e
```

## Instructions

### Go Unit Tests

```go
func TestGetStock(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockStore := mocks.NewMockStore(ctrl)
    mockStore.EXPECT().
        GetStock("BHP").
        Return(&stockv1alpha1.Stock{ProductCode: "BHP"}, nil)

    svc := NewShortsService(mockStore, log.NewLogger())

    resp, err := svc.GetStock(context.Background(),
        connect.NewRequest(&shortsv1alpha1.GetStockRequest{
            ProductCode: "BHP",
        }))

    require.NoError(t, err)
    assert.Equal(t, "BHP", resp.Msg.Stock.ProductCode)
}
```

Use `go.uber.org/mock/gomock` for mocking (NOT golang/mock).

### React Component Tests

```tsx
import { render, screen } from "@testing-library/react";
import { Badge } from "../badge";

describe("Badge", () => {
  it("renders positive variant", () => {
    render(<Badge variant="positive">+5.2%</Badge>);
    expect(screen.getByText("+5.2%")).toBeInTheDocument();
  });
});
```

### E2E Tests (Playwright)

```typescript
import { test, expect } from "@playwright/test";

test("displays top shorted stocks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("top-shorts-list")).toBeVisible();
});
```

## Test Locations

```
web/
├── src/@/components/ui/__tests__/  # Component tests
├── src/@/lib/__tests__/            # Library tests
└── e2e/                            # Playwright E2E

services/
├── shorts/internal/services/shorts/  # Service tests (*_test.go)
├── shorts/internal/store/shorts/     # Store tests (*_test.go)
└── test/integration/                 # Integration tests
```

## Generate Mocks

```bash
mockgen -source=services/shorts/internal/store/shorts/store.go \
  -destination=services/shorts/internal/store/shorts/mocks/mock_store.go \
  -package=mocks
```

