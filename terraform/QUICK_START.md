# Terraform Quick Start Guide

Get your entire infrastructure up and running in minutes.

## 🚀 Quick Start (5 minutes)

### 1. Install Prerequisites

```bash
# Install Terraform
brew install terraform

# Authenticate with GCP
gcloud auth application-default login
gcloud config set project shorted-dev-aba5688f
```

### 2. Create Required Secrets

```bash
# Create Alpha Vantage API key secret
echo -n "YOUR_API_KEY" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
  --data-file=- \
  --project=shorted-dev-aba5688f

# Create Database URL secret (if not exists)
echo -n "postgresql://user:pass@host:5432/db" | gcloud secrets create DATABASE_URL \
  --data-file=- \
  --project=shorted-dev-aba5688f

# Create Postgres password secret
echo -n "YOUR_PASSWORD" | gcloud secrets create APP_STORE_POSTGRES_PASSWORD \
  --data-file=- \
  --project=shorted-dev-aba5688f
```

### 3. Initialize and Deploy

```bash
cd terraform

# Initialize Terraform
make setup

# Review changes
make plan

# Deploy everything
make apply
```

### 4. View Your Services

```bash
# Show all service URLs
make urls

# List all services
make services

# View scheduler jobs
make scheduler
```

## 📦 What You Just Deployed

✅ **4 Cloud Run Services/Jobs**

- Stock Price Ingestion (with 2 scheduled jobs)
- Short Data Sync (with 1 scheduled job)
- Shorts API (always-on)
- CMS (Payload CMS)

✅ **Infrastructure**

- Artifact Registry for Docker images
- GCS bucket for short selling data
- Service accounts with minimal permissions
- IAM bindings for Secret Manager

✅ **3 Cloud Scheduler Jobs**

- Stock price daily sync (weekdays 6 PM AEST)
- Stock price weekly backfill (Sundays 8 PM AEST)
- Short data daily sync (daily 8 PM AEST)

## 🎯 Common Tasks

### Deploy a New Service Version

```bash
# Build and push image
cd services/stock-price-ingestion
./docker-build-push.sh

# Update infrastructure
cd ../../terraform
make apply
```

### View Logs

```bash
make logs-stock-price  # Stock price ingestion logs
make logs-shorts       # Shorts API logs
make logs-short-sync   # Short data sync logs
make logs-cms          # CMS logs
```

### Manually Trigger Jobs

```bash
make trigger-stock-sync  # Trigger stock price sync
make trigger-short-sync  # Trigger short data sync
```

### Update Configuration

```bash
# Edit module configuration
vim modules/stock-price-ingestion/main.tf

# Apply changes
make apply
```

## 📊 Monitoring

### Check Service Status

```bash
# List all services
make services

# Show outputs (includes URLs)
make output
```

### View Scheduler Status

```bash
make scheduler
```

### Check Logs

All logs are viewable in Google Cloud Console or via `gcloud`:

```bash
# View recent logs
gcloud logging read "resource.type=cloud_run_revision" \
  --limit 50 \
  --project=shorted-dev-aba5688f

# Follow logs in real-time
gcloud logging tail "resource.type=cloud_run_revision" \
  --project=shorted-dev-aba5688f
```

## 🔧 Advanced Usage

### Deploy Specific Service

```bash
make plan

# Then target specific module
cd environments/dev
terraform apply -target=module.shorts_api
```

### Import Existing Resources

If you have existing resources:

```bash
cd environments/dev

terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts
```

### Update Image Versions

Edit `environments/dev/terraform.tfvars`:

```hcl
stock_price_ingestion_image = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/stock-price-ingestion:v1.2.3"
shorts_api_image = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts:v0.3.0"
```

Then apply:

```bash
make apply
```

## 🆘 Troubleshooting

### Service Not Starting

```bash
# Check logs
make logs-shorts

# Check service details
gcloud run services describe shorts \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

### Permission Errors

```bash
# Check IAM policies
gcloud projects get-iam-policy shorted-dev-aba5688f \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:shorts@*"
```

### Terraform State Issues

```bash
# Refresh state
make refresh

# Or if needed, reimport
terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts
```

## 📚 Documentation

- [Full README](README.md) - Complete Terraform documentation
- [SERVICES.md](SERVICES.md) - Detailed service information
- [Makefile](Makefile) - All available commands

## 💡 Tips

1. **Always review** with `make plan` before applying
2. **Use make commands** instead of raw terraform commands
3. **Check logs** after deployment to verify everything started correctly
4. **Monitor scheduler jobs** to ensure they're running on schedule
5. **Keep secrets in Secret Manager**, never in code

## 🎓 Next Steps

1. **Set up remote state**: Move state to GCS for team collaboration
2. **Add monitoring**: Set up alerts and dashboards
3. **Create staging environment**: Copy `dev` to `staging`
4. **Document runbooks**: Create operational procedures
5. **Set up CI/CD**: Automate deployments with GitHub Actions

---

**Need help?** Check [README.md](README.md) or [SERVICES.md](SERVICES.md) for detailed information.
