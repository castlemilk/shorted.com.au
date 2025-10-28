# Preview Deployment - Market Data Service Troubleshooting

## Issue

Market data APIs returning 404 or empty responses in preview deployments.

## Root Cause Analysis

The CI configuration is **correct** and includes:

- ✅ Market data service Docker build (line 92 in ci.yml)
- ✅ Cloud Run deployment with proper config (lines 130-148)
- ✅ Environment variables passed to Vercel frontend (lines 198, 203)

However, there are potential issues:

### 1. Cold Start Problem

The market data service is configured with:

```yaml
--min-instances 0
```

This means the service **scales to zero** when not in use. First request after idle period:

- Takes 5-10 seconds to cold start
- May time out on first request
- Subsequent requests are fast

### 2. Deployment Timing

If the preview was deployed before the recent CI fixes, it might not have the updated configuration.

### 3. Missing Data in Database

Preview deployments use the same database, but if the database doesn't have recent stock price data (currently only August 2024 - August 2025), requests for recent periods will return empty.

## Solutions

### Immediate Fix: Trigger New Deployment

Push a commit to your PR to trigger a fresh deployment:

```bash
# Make a trivial change to force redeploy
git commit --allow-empty -m "Redeploy preview with market data service fix"
git push
```

This will:

1. Build fresh Docker images
2. Deploy updated Cloud Run services
3. Configure Vercel with correct environment variables

### Verify Deployment

Once deployed, check the PR comment for URLs:

```markdown
## 🚀 Preview Deployment Ready!

| Service             | URL                                          |
| ------------------- | -------------------------------------------- |
| **Frontend**        | https://pr-XXX.shorted.vercel.app            |
| **Shorts API**      | https://shorts-service-pr-XXX.a.run.app      |
| **Market Data API** | https://market-data-service-pr-XXX.a.run.app |
```

Test the market data service directly:

```bash
# Replace XXX with your PR number
MARKET_DATA_URL="https://market-data-service-pr-XXX-xxx.a.run.app"

# Health check (may take 5-10s on cold start)
curl "$MARKET_DATA_URL/health"

# Test historical data
curl -X POST "$MARKET_DATA_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA", "period": "1y"}'
```

### Address Cold Start Issues

If cold starts are causing problems, update the preview deployment config:

**Option 1: Increase min instances (costs more)**

Edit `.github/workflows/ci.yml` line 138:

```yaml
--min-instances 1 # Keep 1 instance warm (instead of 0)
```

**Option 2: Add startup probe timeout**

Add to the deployment config:

```yaml
--timeout 300s  # Already set (line 140)
--startup-cpu-boost  # Faster cold starts
```

### Data Population

If you need more recent stock price data for testing:

```bash
# Locally, populate recent data
make dev-db
cd services/stock-price-ingestion
python populate_historical_data.py --start-date 2025-08-01
```

This data will be available to all preview deployments since they share the database.

## Monitoring Preview Deployments

### Check Cloud Run Logs

```bash
# View market data service logs
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-service-pr-XXX" \
  --limit 50 \
  --format json

# Check for cold start times
gcloud logging read \
  "resource.type=cloud_run_revision AND textPayload:\"Market data service listening\"" \
  --limit 10
```

### Check Frontend Environment Variables

In your preview deployment, check that the environment variables are set:

```javascript
// In browser console on preview site
console.log(process.env.NEXT_PUBLIC_MARKET_DATA_API_URL);
```

Should show: `https://market-data-service-pr-XXX-xxx.a.run.app`

## Prevention

### For Future PRs

The configuration is now correct, so future PRs should work automatically. Just be aware:

1. **First request is slow** (5-10s cold start)
2. **Service scales to zero** when idle (saves cost)
3. **Data range limitation** (August 2024 - August 2025)

### Health Check Script

Add this to your PR testing workflow:

```bash
#!/bin/bash
# test-preview.sh

PR_NUMBER="123"  # Replace with your PR number
MARKET_DATA_URL=$(gcloud run services describe market-data-service-pr-$PR_NUMBER \
  --region australia-southeast2 --format 'value(status.url)')

echo "Testing market data service: $MARKET_DATA_URL"
echo "Waiting for cold start..."

# Health check with timeout
curl --max-time 30 "$MARKET_DATA_URL/health"

if [ $? -eq 0 ]; then
  echo "✅ Market data service is healthy"
else
  echo "❌ Market data service health check failed"
  exit 1
fi

# Test historical data
echo "Testing historical data endpoint..."
curl --max-time 30 -X POST "$MARKET_DATA_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA", "period": "1y"}' | jq '.prices | length'
```

## Summary

**Current Status:**

- ✅ CI configuration is correct
- ✅ Market data service will deploy for new PRs
- ⚠️ Existing deployments may need redeployment
- ⚠️ Cold starts are expected (5-10s)
- ⚠️ Data is limited to August 2024 - August 2025

**Action Items:**

1. Push commit to trigger fresh preview deployment
2. Wait for deployment (check PR comments)
3. Test market data URLs directly
4. Be patient with cold starts
5. Populate more data if needed for testing

## Configuration Reference

**Market Data Service Config in CI:**

- Port: 8090
- Memory: 256Mi
- CPU: 1
- Min instances: 0 (scales to zero)
- Max instances: 2
- Timeout: 300s (5 minutes)
- Environment: preview
- Database: Shared with production/staging

**Environment Variables Set:**

- `DATABASE_URL` - Full connection string
- `APP_STORE_POSTGRES_ADDRESS` - Host:Port
- `APP_STORE_POSTGRES_USERNAME` - Database user
- `APP_STORE_POSTGRES_PASSWORD` - Database password
- `APP_STORE_POSTGRES_DATABASE` - Database name
- `ENVIRONMENT=preview` - Environment identifier
