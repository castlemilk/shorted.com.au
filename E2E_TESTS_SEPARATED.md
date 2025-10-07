# E2E Tests - Separated Backend and Frontend

## ✅ Test Structure

### 1. Backend E2E Tests (`test-e2e-backend`)

**Purpose**: Test deployed backend API directly  
**Technology**: Go HTTP tests  
**Speed**: Fast (~5-10 seconds)  
**Requirements**: Only deployed backend

**Tests:**

- `TestAPIEndpoints` - All API endpoints
- `TestServiceHealth` - Health checks
- `TestDatabaseConnectivity` - Database connection

**Runs when:**

- ✅ Backend successfully deployed to Cloud Run

### 2. Full-Stack E2E Tests (`test-e2e-frontend`)

**Purpose**: Test complete user flows through UI  
**Technology**: Playwright  
**Speed**: Moderate (~30-60 seconds)  
**Requirements**: Deployed backend + deployed frontend

**Tests:**

- `web/e2e/homepage.spec.ts` - Homepage functionality
- `web/e2e/stock-detail.spec.ts` - Stock detail pages
- `web/e2e/dashboard.spec.ts` - Dashboard features
- `web/e2e/auth.spec.ts` - Authentication flows
- etc.

**Runs when:**

- ✅ Backend deployed
- ✅ Frontend deployed to Vercel
- ✅ Frontend connected to backend

## Workflow Jobs

```yaml
jobs:
  deploy-backend        # Deploy shorts + market-data to Cloud Run
    ↓
  deploy-frontend       # Deploy to Vercel with backend URLs ⭐
    ↓
  ├─ test-e2e-backend   # Go tests → backend API
  └─ test-e2e-frontend  # Playwright → full stack
```

## What Was Configured

### 1. Vercel Deployment via CLI

```yaml
deploy-frontend:
  steps:
    - Deploy to Vercel with environment variables:
        SHORTS_SERVICE_ENDPOINT: <deployed-shorts-url>
        NEXT_PUBLIC_MARKET_DATA_API_URL: <deployed-market-data-url>
```

### 2. Backend E2E Tests

```yaml
test-e2e-backend:
  - Run Go HTTP tests against deployed backend
  - Fast, lightweight
  - No browser/frontend needed
```

### 3. Full-Stack E2E Tests

```yaml
test-e2e-frontend:
  - Install Playwright
  - Wait for Vercel deployment
  - Run Playwright tests against full stack
  - Upload test results
```

## Required Secrets

Add to GitHub repository:

### Vercel

- `VERCEL_TOKEN` - API token from https://vercel.com/account/tokens
- `VERCEL_ORG_ID` - From Vercel project settings (.vercel/project.json)
- `VERCEL_PROJECT_ID` - From Vercel project settings (.vercel/project.json)

### Google Cloud (already configured)

- `GCP_PROJECT_ID`
- `WIP_PROVIDER`
- `SA_EMAIL`
- `DATABASE_URL`

## Test Execution Flow

### Scenario 1: Full GCP + Vercel Setup

```
1. Deploy Backend (Cloud Run) ✅
2. Deploy Frontend (Vercel) ✅
3. Backend E2E Tests ✅
4. Full-Stack E2E Tests ✅
```

### Scenario 2: Only GCP (No Vercel Secrets)

```
1. Deploy Backend (Cloud Run) ✅
2. Deploy Frontend ⏭️ Skipped (no Vercel secrets)
3. Backend E2E Tests ✅
4. Full-Stack E2E Tests ⏭️ Skipped (no frontend)
```

### Scenario 3: No GCP Secrets

```
1. Deploy Backend ⏭️ Skipped
2. Unit Tests ✅
3. Integration Tests (local) ✅
```

## Benefits of Separation

### Backend E2E

✅ **Fast** - No browser overhead  
✅ **Reliable** - Simple HTTP requests  
✅ **Always runs** - Only needs backend  
✅ **Clear failures** - API-level issues

### Frontend E2E

✅ **Realistic** - Tests actual user experience  
✅ **Comprehensive** - Full stack integration  
✅ **Visual validation** - Screenshots on failure  
✅ **User flows** - Complete journeys

## Local Testing

### Backend E2E (Against Deployed Service)

```bash
# Get backend URL from PR comment
export BACKEND_URL=https://shorts-service-pr-123.run.app

# Run backend E2E tests
cd test/integration
BACKEND_URL=$BACKEND_URL go test -v -run "TestAPIEndpoints"
```

### Full-Stack E2E (Against Preview)

```bash
# Get URLs from PR comment
export BASE_URL=https://pr-123-shorted.vercel.app
export SHORTS_URL=https://shorts-service-pr-123.run.app

# Run Playwright E2E tests
cd web
BASE_URL=$BASE_URL npm run test:e2e
```

## PR Comment Output

When a PR is created, the bot will comment:

````markdown
## 🚀 Preview Deployment URLs

### Frontend

✅ **Preview**: https://pr-123-shorted.vercel.app

### Backend Services

✅ **Shorts API**: https://shorts-service-pr-123.run.app
✅ **Market Data API**: https://market-data-service-pr-123.run.app

### E2E Testing

```bash
# Test the full preview stack
cd web
BASE_URL=https://pr-123-shorted.vercel.app npm run test:e2e
```
````

````

## Playwright Config

Already configured to support remote testing:

```typescript
// playwright.config.ts
baseURL: process.env.BASE_URL || 'http://localhost:3020'
````

## Test Results

### Backend E2E

- Fast execution (~10s)
- Tests API endpoints directly
- Reports pass/fail immediately

### Frontend E2E

- Comprehensive testing (~60s)
- Screenshots on failure
- Playwright HTML report
- Uploaded as CI artifacts

## Troubleshooting

### Vercel Deployment Fails

- Check `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` secrets
- Verify token has deployment permissions
- Check Vercel project exists

### Backend E2E Fails

- Check backend deployment succeeded
- Verify backend health endpoint
- Review backend logs in Cloud Run console

### Frontend E2E Fails

- Check frontend deployment URL is accessible
- Verify backend URLs in frontend environment
- Review Playwright screenshots in artifacts
- Check browser console logs

## Next Steps

1. ✅ **Workflow configured** - Separate backend and frontend E2E
2. ⏳ **Add Vercel secrets** - Required for frontend deployment
3. ⏳ **Test in PR** - Create PR to verify workflow
4. ✅ **Documentation** - Setup guides created

## Documentation

- `E2E_TESTS_SEPARATED.md` - This file (test architecture)
- `VERCEL_PREVIEW_BACKEND_SETUP.md` - Vercel configuration
- `PREVIEW_E2E_TESTING.md` - Testing guide
- `ALL_TESTS_FIXED.md` - Complete test fix summary
