# Deployment Guide: Stock Price Ingestion Service

## Prerequisites

1. **GCP Project Setup**

   - Project: `shorted-dev-aba5688f`
   - Active GCP project with billing enabled
   - gcloud CLI installed and authenticated
   - Required APIs enabled (done automatically by deploy script)

2. **Alpha Vantage API Key**
   - Get free key: https://www.alphavantage.co/support/#api-key
   - No credit card required
   - 5 requests/minute, 500/day on free tier

## One-Time Setup

### 1. Create Secrets in Secret Manager

**Option A: Interactive setup (Recommended)**

```bash
cd services/stock-price-ingestion
./setup-secrets.sh
```

This will:

- Prompt you for your Alpha Vantage API key
- Create the secret in Secret Manager
- Grant necessary IAM permissions
- Verify setup

**Option B: Manual setup**

```bash
# Set your project
gcloud config set project shorted-dev-aba5688f

# Create Alpha Vantage API key secret
echo -n "your_api_key_here" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --replication-policy="automatic" \
  --project=shorted-dev-aba5688f

# Grant service account access
gcloud secrets add-iam-policy-binding ALPHA_VANTAGE_API_KEY \
  --member="serviceAccount:stock-price-ingestion@shorted-dev-aba5688f.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=shorted-dev-aba5688f
```

### 2. Verify Secrets

```bash
# List all secrets
gcloud secrets list --project=shorted-dev-aba5688f

# Check specific secret
gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=shorted-dev-aba5688f

# Verify you can access it (this actually retrieves the value)
gcloud secrets versions access latest --secret=ALPHA_VANTAGE_API_KEY --project=shorted-dev-aba5688f
```

## Deploying the Service

### Automatic Deployment (Recommended)

```bash
cd services/stock-price-ingestion
./deploy.sh
```

This will:

1. ✅ Verify Alpha Vantage API key secret exists (creates if needed)
2. ✅ Enable required GCP APIs
3. ✅ Create service account (if needed)
4. ✅ Grant IAM permissions
5. ✅ Build Docker image
6. ✅ Deploy to Cloud Run
7. ✅ Create Cloud Scheduler jobs
8. ✅ Verify deployment

### Manual Deployment

```bash
# Build and deploy
gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=shorted-dev-aba5688f

# Create scheduler jobs (see deploy.sh for full commands)
```

## Cloud Run Configuration

The service is configured to load secrets from Secret Manager:

```yaml
env:
  - name: ALPHA_VANTAGE_API_KEY
    valueFrom:
      secretKeyRef:
        name: ALPHA_VANTAGE_API_KEY
        key: latest
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: DATABASE_URL
        key: latest
```

## Scheduled Jobs

Two Cloud Scheduler jobs are automatically created:

### 1. Daily Sync Job

- **Name**: `stock-price-daily-sync`
- **Schedule**: Weekdays at 6 PM AEST (8 AM UTC)
- **Cron**: `0 8 * * 1-5`
- **Endpoint**: `/sync-all`
- **Purpose**: Fetch yesterday's data for all stocks

### 2. Weekly Backfill Job

- **Name**: `stock-price-weekly-sync`
- **Schedule**: Sundays at 8 PM AEST (10 AM UTC)
- **Cron**: `0 10 * * 0`
- **Endpoint**: `/sync`
- **Purpose**: Comprehensive 7-day backfill

## Updating Secrets

### Update Alpha Vantage API Key

```bash
# Add new version
echo -n "new_api_key" | gcloud secrets versions add ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --project=shorted-dev-aba5688f

# Cloud Run automatically picks up the latest version
# No redeployment needed!
```

### Rotate Secrets

```bash
# Disable old version
gcloud secrets versions disable <version-number> \
  --secret=ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f

# Destroy old version (irreversible)
gcloud secrets versions destroy <version-number> \
  --secret=ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f
```

## Monitoring

### View Logs

```bash
# Recent logs
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="stock-price-ingestion"' \
  --limit=50 \
  --project=shorted-dev-aba5688f \
  --format=json

# Filter by severity
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="stock-price-ingestion" AND severity>=ERROR' \
  --limit=20 \
  --project=shorted-dev-aba5688f
```

### Check Service Health

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe stock-price-ingestion \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f \
  --format='value(status.url)')

# Health check
curl $SERVICE_URL/health
```

### Manual Trigger

```bash
# Trigger daily sync
gcloud scheduler jobs run stock-price-daily-sync \
  --location=australia-southeast2 \
  --project=shorted-dev-aba5688f

# Trigger weekly backfill
gcloud scheduler jobs run stock-price-weekly-sync \
  --location=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

## Troubleshooting

### Secret Not Found Error

```bash
# Verify secret exists
gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=shorted-dev-aba5688f

# If not found, create it
./setup-secrets.sh
```

### Permission Denied Errors

```bash
# Check service account permissions
gcloud secrets get-iam-policy ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f

# Re-grant if needed
gcloud secrets add-iam-policy-binding ALPHA_VANTAGE_API_KEY \
  --member="serviceAccount:stock-price-ingestion@shorted-dev-aba5688f.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=shorted-dev-aba5688f
```

### Service Won't Start

```bash
# Check logs for errors
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="stock-price-ingestion" AND severity>=ERROR' \
  --limit=50 \
  --project=shorted-dev-aba5688f

# Common issues:
# 1. Secret not accessible -> Check IAM permissions
# 2. Invalid API key -> Update secret value
# 3. Database connection -> Check DATABASE_URL secret
```

### Rate Limit Issues

The service automatically falls back to Yahoo Finance when Alpha Vantage rate limits are hit. Check logs for:

```
⚠️ Primary provider rate limit exceeded for STOCK
🔄 Falling back to Yahoo Finance for STOCK...
✅ Fallback provider success for STOCK
```

## Security Best Practices

✅ **Use Secret Manager** - Never hardcode credentials  
✅ **Rotate secrets regularly** - Update API keys periodically  
✅ **Minimal permissions** - Service account has only necessary roles  
✅ **Audit access** - Monitor secret access in Cloud Logging  
✅ **Version secrets** - Keep history of secret changes

## Cost Optimization

- **Cloud Run**: Pay only when running (serverless)
- **Alpha Vantage**: Free tier is usually sufficient with fallback
- **Secret Manager**: First 6 secret versions free, then $0.06/version/month
- **Cloud Scheduler**: Free for first 3 jobs/month

## Support

For issues:

1. Check logs: `gcloud logging read ...`
2. Verify secrets: `gcloud secrets describe ...`
3. Test locally: See `QUICK_START_PROVIDERS.md`
4. Review documentation: `PLUGGABLE_PROVIDERS_IMPLEMENTED.md`
