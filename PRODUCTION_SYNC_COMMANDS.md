# Production Sync Commands - Quick Reference

## 🎯 After Deployment

Once PR #44 deploys (check GitHub Actions), use these commands to sync stocks in production.

## Method 1: Use the New SyncKeyMetrics API (Recommended)

### Get Admin Token First

```bash
# Login and get JWT token
# TODO: Add authentication flow here
```

### Sync CVN (and other specific stocks)

```bash
# Sync just CVN
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_ADMIN_JWT_TOKEN>" \
  -d '{
    "stockCodes": ["CVN"],
    "force": true
  }' | jq .

# Expected response:
# {
#   "totalRequested": 1,
#   "successfullySynced": 1,
#   "results": [{
#     "stockCode": "CVN",
#     "success": true,
#     "metrics": {
#       "marketCap": 152072384,
#       "beta": 0.88
#     }
#   }]
# }
```

### Sync Multiple Stocks

```bash
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_ADMIN_JWT_TOKEN>" \
  -d '{
    "stockCodes": ["CVN", "EVN", "WOW", "NAB", "AMP"],
    "force": true
  }' | jq .
```

### Sync ALL Stocks

```bash
# Empty stockCodes array = sync all stocks in database
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_ADMIN_JWT_TOKEN>" \
  -d '{
    "stockCodes": [],
    "force": false
  }' | jq .

# Note: This can take 10-30 minutes for ~2000 stocks
# Better to use Method 2 (Cloud Run Job) for full sync
```

## Method 2: Trigger Daily Sync Job (For Full Sync)

This runs the comprehensive daily sync which updates ALL stocks + prices + shorts data.

```bash
# Trigger the Cloud Run job
make daily-sync-execute

# Or manually:
gcloud run jobs execute comprehensive-daily-sync \
  --region asia-northeast1 \
  --project shorted-dev-aba5688f
```

### Monitor Progress

```bash
# View logs
make daily-sync-logs

# Or manually:
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
  --limit 100 \
  --project shorted-dev-aba5688f \
  --format="table(timestamp, severity, textPayload)"
```

## Method 3: Database Direct Update (Emergency Only)

If you need to manually update a single stock's key_metrics:

```bash
# Get production database credentials
export DATABASE_URL="<production-db-url>"

# Update CVN directly
psql "$DATABASE_URL" -c "
UPDATE \"company-metadata\"
SET key_metrics = '{
  \"market_cap\": 152072384,
  \"pe_ratio\": null,
  \"beta\": 0.88,
  \"fifty_two_week_high\": 0.16,
  \"fifty_two_week_low\": 0.085,
  \"avg_volume\": 1535318
}'::jsonb,
key_metrics_updated_at = CURRENT_TIMESTAMP
WHERE stock_code = 'CVN';
"
```

## Verification

### Check if CVN has data

```bash
curl -s "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStockDetails" \
  -H "Content-Type: application/json" \
  -d '{"productCode":"CVN"}' | \
  jq '{
    stockCode: .productCode,
    companyName: .companyName,
    marketCap: .financialStatements.info.marketCap,
    peRatio: .financialStatements.info.peRatio,
    beta: .financialStatements.info.beta
  }'
```

Expected:
```json
{
  "stockCode": "CVN",
  "companyName": "CARNARVON ENERGY LIMITED",
  "marketCap": 152072384,  // ✅ Should have value
  "peRatio": null,
  "beta": 0.88
}
```

### Check Multiple Stocks

```bash
for code in CVN EVN WOW NAB CBA; do
  echo "=== $code ==="
  curl -s "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStockDetails" \
    -H "Content-Type: application/json" \
    -d "{\"productCode\":\"$code\"}" | \
    jq -r '.financialStatements.info.marketCap // "NO DATA"'
done
```

## Timeline

### Immediate (5-10 minutes)
✅ PR #44 pushed - CI/CD triggered
- Building Docker image with Python + yfinance
- Running tests
- Deploying to preview environment

### After Preview Deploy (15-20 minutes)
🔄 Test in preview environment
- Use preview URL from PR comment
- Test CVN market cap display
- Test sync API endpoint

### After Merge to Main (30 minutes)
🔄 Deploys to dev environment
- Available at dev API URL
- Daily sync job has access to new code

### Daily Sync Completion (1-2 hours from now)
✅ Daily sync job completes
- All ~2000 stocks have key_metrics
- CVN and all other stocks show market cap

### Production Release (When ready)
🚀 Deploy to production
- Create release on GitHub
- Auto-deploys to production
- Run sync API or wait for daily sync

## Recommended Approach

**Best Practice**: Use a combination:

1. **After Deployment**:
   ```bash
   # Sync just the stocks you need immediately
   curl ... /SyncKeyMetrics -d '{"stockCodes": ["CVN", "EVN"]}'
   ```

2. **Let Daily Sync Handle the Rest**:
   - Runs at 2 AM AEST every day
   - Updates all stocks automatically
   - No manual intervention needed

3. **Use On-Demand API for**:
   - Newly listed stocks
   - Stocks with stale data
   - After corporate events (splits, mergers, etc.)
   - Testing and validation

## Quick Commands

```bash
# Sync CVN right now in production
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Authorization: Bearer $(YOUR_TOKEN)" \
  -d '{"stockCodes": ["CVN"], "force": true}'

# Trigger full daily sync
make daily-sync-execute

# Check sync job logs
make daily-sync-logs

# Verify CVN has data
curl -s "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStockDetails" \
  -H "Content-Type: application/json" \
  -d '{"productCode":"CVN"}' | jq '.financialStatements.info.marketCap'
```

## Troubleshooting

### CVN still shows no data after sync

**Check 1**: Was the sync successful?
```bash
# Response should show success: true
curl ... /SyncKeyMetrics -d '{"stockCodes": ["CVN"]}' | jq '.results[0].success'
```

**Check 2**: Is the new code deployed?
```bash
# Check service version
curl https://api.shorted.com.au/health

# Check GitHub Actions for deployment status
```

**Check 3**: Is CVN in company-metadata?
```bash
# Should return CVN data
curl ... /GetStock -d '{"productCode": "CVN"}'
```

### Sync API returns 403 Forbidden

- Ensure you have admin JWT token
- Check token hasn't expired
- Verify admin role in user claims

### Sync API returns 401 Unauthenticated

- Add Authorization header
- Token format: `Bearer <jwt-token>`

## Support

For issues:
1. Check GitHub Actions for deployment status
2. View Cloud Run logs: `make daily-sync-logs`
3. Test locally first: `curl http://localhost:9091/...`

