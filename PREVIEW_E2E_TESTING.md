# E2E Testing with Preview Deployments

## Quick Start

When you create a PR, the workflow will:
1. ✅ Deploy backend services to Cloud Run (with PR-specific URLs)
2. ✅ Post backend URLs in PR comment
3. ✅ Vercel auto-deploys frontend (via GitHub integration)

## Running E2E Tests Against Preview

### Step 1: Get URLs from PR Comment

The GitHub Actions bot posts:
```
🔗 Preview Backend Services

Shorts API: https://shorts-service-pr-123-abc123.a.run.app
Market Data API: https://market-data-service-pr-123-abc123.a.run.app
```

### Step 2: Get Vercel Preview URL

Vercel bot comments with:
```
🔍 Inspect: https://vercel.com/your-org/your-project/abc123
✅ Preview: https://pr-123-shorted.vercel.app
```

### Step 3: Run E2E Tests

```bash
cd web

# Quick test script
./scripts/test-preview.sh 123 https://pr-123-shorted.vercel.app

# Or manual:
BASE_URL=https://pr-123-shorted.vercel.app \
SHORTS_URL=https://shorts-service-pr-123.run.app \
MARKET_DATA_URL=https://market-data-service-pr-123.run.app \
npm run test:e2e
```

## Configure Vercel to Use Preview Backends

### Option A: Vercel Dashboard (One-time Setup)

1. Go to project settings → Environment Variables
2. Add for **Preview** environment:
   ```
   SHORTS_SERVICE_ENDPOINT = https://shorts-service-pr-{PR_NUMBER}.run.app
   NEXT_PUBLIC_MARKET_DATA_API_URL = https://market-data-service-pr-{PR_NUMBER}.run.app
   ```
3. Use `{PR_NUMBER}` placeholder or set per-PR

### Option B: Vercel CLI (Per-PR)

```bash
# Set environment variables for specific preview
vercel env add SHORTS_SERVICE_ENDPOINT preview
# Paste: https://shorts-service-pr-123.run.app

vercel env add NEXT_PUBLIC_MARKET_DATA_API_URL preview
# Paste: https://market-data-service-pr-123.run.app

# Redeploy
vercel --prod=false
```

### Option C: Dynamic Resolution (Code)

Update your API client to auto-resolve:

```typescript
// lib/api-client.ts
function getShortsEndpoint() {
  // PR-specific backend (from build-time env var)
  if (process.env.SHORTS_SERVICE_ENDPOINT) {
    return process.env.SHORTS_SERVICE_ENDPOINT;
  }
  
  // Fallback to dev backend
  return 'https://shorts-dev.run.app';
}
```

## What's Been Configured

### ✅ Workflow Updates
- Backend URLs posted to PR comments
- Integration tests use deployed backends
- Test summary reports results

### ✅ Playwright Config
- Supports `BASE_URL` env var for testing remote deployments
- Supports `SHORTS_URL` and `MARKET_DATA_URL` for backend URLs
- Works with both local and remote testing

### ✅ Test Script
- `web/scripts/test-preview.sh` - Automated E2E testing
- Checks backend health before running tests
- Clear error messages if backends not available

## Test Flow

```
1. Create PR
   ↓
2. GitHub Actions deploys backends
   ↓
3. GitHub bot comments with backend URLs
   ↓
4. Vercel auto-deploys frontend
   ↓
5. Configure Vercel env vars (one-time)
   ↓
6. Run E2E tests: ./scripts/test-preview.sh <pr> <vercel-url>
   ↓
7. Tests run against full preview stack
```

## Example E2E Test

```typescript
// e2e/stock-page.spec.ts
import { test, expect } from '@playwright/test';

test('stock page loads data from preview backend', async ({ page }) => {
  // This will use BASE_URL from environment
  await page.goto('/shorts/CBA');
  
  // Verify backend data loads
  await expect(page.locator('h1')).toContainText('CBA');
  await expect(page.locator('[data-testid="short-position"]')).toBeVisible();
  
  // Check chart renders (market data API)
  await expect(page.locator('canvas')).toBeVisible();
});
```

## Verifying Backend Connection

### Check Health Endpoints

```bash
# From PR comment, get backend URLs
SHORTS_URL="https://shorts-service-pr-123.run.app"

# Test health
curl $SHORTS_URL/health
# Expected: OK

# Test API
curl -X POST $SHORTS_URL/shorts.v1alpha1.ShortedStocksService/GetTopShorts \
  -H "Content-Type: application/json" \
  -d '{"period":"1M","limit":10}'
# Expected: JSON response with stock data
```

### Check Frontend→Backend Connection

1. Open Vercel preview in browser
2. Open DevTools → Network tab
3. Navigate to stock page
4. Check API calls:
   - ✅ Should call `https://shorts-service-pr-*.run.app`
   - ❌ If calling `localhost` → env vars not set

## Troubleshooting

### Backend URLs Not in PR Comment
- Check GCP secrets are configured
- Check deploy-backend job succeeded
- URLs are in `deploy-backend` outputs

### Vercel Using Wrong Backend
- Environment variables not set in Vercel
- Follow "Configure Vercel" steps above
- May need to redeploy after setting env vars

### E2E Tests Fail
- Backend may be cold starting (2-3s delay)
- Check backend health endpoints
- Verify CORS allows Vercel domains
- Check browser console for errors

### CORS Errors
Backend CORS config in `shorts/internal/services/shorts/serve.go`:
```go
AllowedOrigins: []string{
  "https://*.vercel.app",
  "https://*.shorted.com.au",
  // ... local origins
}
```

## CI Integration (Future)

To fully automate E2E testing in CI:

1. **Option A**: Add Vercel secrets to GitHub Actions
2. **Option B**: Use Vercel CLI in workflow
3. **Option C**: Manual testing after PR review

Current approach: **Manual E2E testing** using the script after preview deploys.

## Summary

| Component | Status | How to Access |
|-----------|--------|---------------|
| Backend Services | ✅ Auto-deployed per PR | GitHub PR comment |
| Frontend | ✅ Auto-deployed by Vercel | Vercel bot comment |
| Backend→Frontend Connection | ⏳ Manual config | Set Vercel env vars |
| E2E Tests | ⏳ Manual trigger | Run test script |

## Next Steps

1. ✅ **Create PR** - Backends deploy automatically
2. ✅ **Copy URLs** - From GitHub PR comment
3. ⏳ **Configure Vercel** - Set environment variables (one-time)
4. ⏳ **Run E2E tests** - `./scripts/test-preview.sh <pr> <vercel-url>`

## Documentation

- [Vercel Backend Setup](./VERCEL_PREVIEW_BACKEND_SETUP.md) - Detailed configuration
- [E2E Testing](./E2E_TESTING.md) - E2E testing guide
- [Preview Deployments](./docs/PREVIEW_DEPLOYMENTS.md) - Preview deployment docs
