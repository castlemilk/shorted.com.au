# Cloud Run Secret Management Setup

## Summary

The Stock Price Ingestion service on Cloud Run now loads the Alpha Vantage API key securely from GCP Secret Manager.

## What's Configured

### 1. **Service Configuration** ✅

Both `service.yaml` and `service.template.yaml` are configured to load secrets:

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

### 2. **Deployment Script** ✅

`deploy.sh` now automatically:

- Checks if the secret exists in Secret Manager
- Creates it from environment variable if needed
- Grants IAM permissions to the service account
- Verifies setup before deploying

### 3. **Setup Script** ✅

New `setup-secrets.sh` script for one-time secret setup:

- Interactive prompts for API keys
- Creates secrets in Secret Manager
- Configures IAM permissions
- Verifies everything is working

## How to Deploy

### First Time Setup

**Step 1: Create the secret in Secret Manager**

```bash
cd services/stock-price-ingestion

# Option A: Interactive (Recommended)
./setup-secrets.sh

# Option B: From environment variable
export ALPHA_VANTAGE_API_KEY='your_key_here'
echo -n "$ALPHA_VANTAGE_API_KEY" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --replication-policy="automatic" \
  --project=shorted-dev-aba5688f
```

**Step 2: Deploy the service**

```bash
./deploy.sh
```

The deploy script will:

1. ✅ Verify the secret exists (or create it)
2. ✅ Grant service account access
3. ✅ Build and deploy to Cloud Run
4. ✅ Set up scheduled jobs

### Updating the Service

After the initial setup, you can update without creating secrets again:

```bash
cd services/stock-price-ingestion
./deploy.sh
```

## Verifying the Setup

### Check Secrets

```bash
# List all secrets
gcloud secrets list --project=shorted-dev-aba5688f

# View secret details
gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=shorted-dev-aba5688f

# View secret value (be careful!)
gcloud secrets versions access latest \
  --secret=ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f
```

### Check IAM Permissions

```bash
# View who has access to the secret
gcloud secrets get-iam-policy ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f
```

Should show:

```yaml
bindings:
  - members:
      - serviceAccount:stock-price-ingestion@shorted-dev-aba5688f.iam.gserviceaccount.com
    role: roles/secretmanager.secretAccessor
```

### Test the Deployment

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe stock-price-ingestion \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f \
  --format='value(status.url)')

# Check health (should return 200)
curl -i $SERVICE_URL/health

# Check logs for secret loading
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="stock-price-ingestion"
   AND textPayload:"provider initialized"' \
  --limit=10 \
  --project=shorted-dev-aba5688f
```

Expected log output:

```
✅ Primary provider initialized: Alpha Vantage
✅ Fallback provider initialized: Yahoo Finance
```

## Updating the API Key

To rotate or update your Alpha Vantage API key:

```bash
# Add new version
echo -n "new_api_key" | gcloud secrets versions add ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --project=shorted-dev-aba5688f

# Cloud Run automatically picks up the latest version
# No redeployment needed!

# Optional: Disable old version
gcloud secrets versions disable <version-number> \
  --secret=ALPHA_VANTAGE_API_KEY \
  --project=shorted-dev-aba5688f
```

## Architecture

```
┌─────────────────────────────────────┐
│   Cloud Run Service                 │
│   (stock-price-ingestion)           │
│                                     │
│   Service Account:                  │
│   stock-price-ingestion@...         │
└──────────────┬──────────────────────┘
               │
               │ secretAccessor role
               ▼
┌─────────────────────────────────────┐
│   GCP Secret Manager                │
│                                     │
│   - ALPHA_VANTAGE_API_KEY          │
│   - DATABASE_URL                    │
└─────────────────────────────────────┘
```

## Security Features

✅ **Secrets stored in Secret Manager** - Never in source code or environment variables  
✅ **IAM-controlled access** - Only service account can access  
✅ **Automatic rotation** - Update secrets without redeploying  
✅ **Audit logging** - Track all secret access  
✅ **Version history** - Keep previous versions for rollback  
✅ **Encrypted at rest and in transit** - GCP handles encryption

## Files Modified

- `services/stock-price-ingestion/service.yaml` - Added ALPHA_VANTAGE_API_KEY secret reference
- `services/stock-price-ingestion/service.template.yaml` - Added ALPHA_VANTAGE_API_KEY secret reference
- `services/stock-price-ingestion/deploy.sh` - Added secret verification and creation
- `services/stock-price-ingestion/setup-secrets.sh` - New interactive setup script
- `services/stock-price-ingestion/DEPLOYMENT.md` - Complete deployment guide

## Troubleshooting

### "Secret not found" error

```bash
# Create the secret
./setup-secrets.sh

# Or manually
echo -n "your_key" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --replication-policy="automatic" \
  --project=shorted-dev-aba5688f
```

### "Permission denied" error

```bash
# Grant access to service account
gcloud secrets add-iam-policy-binding ALPHA_VANTAGE_API_KEY \
  --member="serviceAccount:stock-price-ingestion@shorted-dev-aba5688f.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=shorted-dev-aba5688f
```

### Service using fallback provider only

Check logs:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="stock-price-ingestion"
   AND (textPayload:"provider" OR severity>=WARNING)' \
  --limit=50 \
  --project=shorted-dev-aba5688f
```

If you see "⚠️ Primary provider not configured", the secret isn't loading correctly. Verify:

1. Secret exists: `gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=shorted-dev-aba5688f`
2. IAM permissions are correct
3. Service has been redeployed with the updated configuration

## Cost

- **Secret Manager**: First 6 versions per secret are free, then $0.06/version/month
- **Secret access**: First 10,000 access operations per month are free
- **Total estimated cost**: ~$0/month (within free tier)

## Next Steps

After setup:

1. ✅ Deploy the service: `./deploy.sh`
2. ✅ Verify in logs that Alpha Vantage is being used
3. ✅ Monitor scheduled jobs running successfully
4. ✅ Check database for new stock price data
