# Vercel Preview with Preview Backend Setup

## Overview

Configure your Vercel preview deployments to connect to PR-specific backend services deployed on Google Cloud Run.

## Architecture

```
GitHub PR
├── Backend Services (Cloud Run)
│   ├── shorts-service-pr-123 → https://shorts-pr-123.run.app
│   └── market-data-service-pr-123 → https://market-data-pr-123.run.app
└── Frontend (Vercel)
    └── pr-123-shorted.vercel.app
        ├── SHORTS_SERVICE_ENDPOINT → https://shorts-pr-123.run.app
        └── NEXT_PUBLIC_MARKET_DATA_API_URL → https://market-data-pr-123.run.app
```

## Option 1: Manual Configuration (Quick)

### Step 1: Get Backend URLs

When you create a PR, the GitHub Actions bot will comment with backend URLs:

```
🔗 Preview Backend Services

Shorts API: https://shorts-service-pr-123.run.app
Market Data API: https://market-data-service-pr-123.run.app
```

### Step 2: Configure Vercel Environment Variables

#### Via Vercel Dashboard:

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project
3. Go to **Settings** → **Environment Variables**
4. Add variables for **Preview** environment:
   - `SHORTS_SERVICE_ENDPOINT` = `https://shorts-service-pr-123.run.app`
   - `NEXT_PUBLIC_MARKET_DATA_API_URL` = `https://market-data-service-pr-123.run.app`
5. Redeploy the preview branch

#### Via Vercel CLI:

```bash
# Get backend URLs from GitHub PR comment
export SHORTS_URL="https://shorts-service-pr-123.run.app"
export MARKET_DATA_URL="https://market-data-service-pr-123.run.app"

# Set environment variables
vercel env add SHORTS_SERVICE_ENDPOINT preview
# Paste the SHORTS_URL when prompted

vercel env add NEXT_PUBLIC_MARKET_DATA_API_URL preview
# Paste the MARKET_DATA_URL when prompted

# Trigger redeploy
vercel --prod=false
```

### Step 3: Verify Connection

Visit your Vercel preview URL and check:

- ✅ Stock data loads
- ✅ Charts render
- ✅ API calls succeed
- ✅ No CORS errors

## Option 2: Automated via GitHub Actions (Advanced)

### Add Vercel Integration to Workflow

```yaml
- name: Deploy to Vercel with backend URLs
  env:
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
    VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
    VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
  run: |
    vercel deploy \
      --token=$VERCEL_TOKEN \
      --build-env SHORTS_SERVICE_ENDPOINT=${{ needs.deploy-backend.outputs.shorts-url }} \
      --build-env NEXT_PUBLIC_MARKET_DATA_API_URL=${{ needs.deploy-backend.outputs.market-data-url }} \
      --env SHORTS_SERVICE_ENDPOINT=${{ needs.deploy-backend.outputs.shorts-url }} \
      --env NEXT_PUBLIC_MARKET_DATA_API_URL=${{ needs.deploy-backend.outputs.market-data-url }}
```

### Required Vercel Secrets

Add to GitHub repository secrets:

- `VERCEL_TOKEN` - Vercel API token
- `VERCEL_ORG_ID` - Your Vercel organization ID
- `VERCEL_PROJECT_ID` - Your project ID

## Option 3: Use Vercel's GitHub Integration (Recommended)

Vercel automatically deploys PRs via GitHub integration. To connect to preview backends:

### Setup:

1. **Configure default preview environment variables** in Vercel:

   - `SHORTS_SERVICE_ENDPOINT` = `https://shorts-dev.run.app` (fallback)
   - `NEXT_PUBLIC_MARKET_DATA_API_URL` = `https://market-data-dev.run.app` (fallback)

2. **Override per PR** using Vercel CLI or Dashboard with PR-specific URLs

3. **Or use environment variable override** in your frontend code:
   ```typescript
   // In your API client
   const shortsEndpoint =
     process.env.SHORTS_SERVICE_ENDPOINT ||
     process.env.NEXT_PUBLIC_PREVIEW_SHORTS_URL ||
     "https://shorts-dev.run.app";
   ```

## E2E Testing with Preview Backends

### Run Playwright Tests Against Preview

```bash
# Get URLs from GitHub PR comment
export SHORTS_URL="https://shorts-service-pr-123.run.app"
export MARKET_DATA_URL="https://market-data-service-pr-123.run.app"
export BASE_URL="https://pr-123-shorted.vercel.app"

# Run E2E tests
cd web
BASE_URL=$BASE_URL npm run test:e2e
```

### Update Playwright Config

```typescript
// web/playwright.config.ts
export default defineConfig({
  use: {
    baseURL:
      process.env.BASE_URL || process.env.VERCEL_URL || "http://localhost:3020",
    // Backend URLs available in tests via process.env
  },
});
```

### Example E2E Test

```typescript
// e2e/stock-page.spec.ts
test("stock page loads data from preview backend", async ({ page }) => {
  await page.goto("/shorts/CBA");

  // Wait for data from backend
  await page.waitForSelector('[data-testid="stock-chart"]');

  // Verify backend data loaded
  await expect(page.locator("h1")).toContainText("CBA");
});
```

## Debugging

### Check Backend Connectivity

```bash
# Test shorts API
curl https://shorts-service-pr-123.run.app/health

# Test market data API
curl https://market-data-service-pr-123.run.app/health
```

### Check Vercel Environment Variables

```bash
# List all environment variables
vercel env ls

# Check specific variable
vercel env pull .env.preview
cat .env.preview | grep SHORTS_SERVICE_ENDPOINT
```

### Check Frontend API Calls

1. Open browser DevTools → Network tab
2. Visit your Vercel preview URL
3. Check API calls - should go to `https://shorts-service-pr-*.run.app`
4. If calling `localhost` or wrong URL, env vars aren't set

## Backend URL Format

Backend services follow this naming:

- **Shorts**: `https://shorts-service-pr-{PR_NUMBER}-{hash}.a.run.app`
- **Market Data**: `https://market-data-service-pr-{PR_NUMBER}-{hash}.a.run.app`

The exact URLs are posted in PR comments by the GitHub Actions bot.

## Cleanup

Backend services automatically:

- ✅ Scale to zero when not in use
- ✅ Get deleted when PR is closed (via cleanup workflow)
- ✅ Are labeled with PR number for easy identification

## Next Steps

1. ✅ **Backend URLs posted to PR** - Check GitHub PR comments
2. ⏳ **Configure Vercel** - Add environment variables
3. ⏳ **Test E2E** - Run Playwright tests against preview
4. ✅ **Automatic cleanup** - Services removed on PR close

## Troubleshooting

### CORS Errors

- Backend services allow CORS from vercel.app domains
- Check `shorts/internal/services/shorts/serve.go` for CORS config

### Authentication Errors

- Preview backends have `--allow-unauthenticated`
- No auth required for preview testing

### Connection Timeouts

- Backend services cold start in 2-3 seconds
- First request after idle may be slower

### Wrong Backend URL

- Check environment variables in Vercel dashboard
- Verify PR comment has correct URLs
- Backend URLs change per PR

## References

- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)
- [Vercel CLI](https://vercel.com/docs/cli)
- [Playwright Testing](https://playwright.dev/)
- [GitHub Actions Outputs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idoutputs)
