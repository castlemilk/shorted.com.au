# Managed Services

This document describes all services managed by Terraform in the Shorted infrastructure.

## 🚀 Services Overview

| Service                   | Type              | Purpose                                                   | Schedule       |
| ------------------------- | ----------------- | --------------------------------------------------------- | -------------- |
| **stock-price-ingestion** | Cloud Run Service | Fetches ASX stock prices from Alpha Vantage/Yahoo Finance | Daily + Weekly |
| **short-data-sync**       | Cloud Run Job     | Syncs ASIC short selling data to database                 | Daily          |
| **shorts**                | Cloud Run Service | Main API service for stock shorts data                    | Always On      |
| **cms**                   | Cloud Run Service | Payload CMS for content management                        | Always On      |

---

## 📊 Stock Price Ingestion

**Module**: `modules/stock-price-ingestion`

### What It Does

- Fetches historical and current stock prices for ASX stocks
- Uses Alpha Vantage as primary data source
- Falls back to Yahoo Finance if Alpha Vantage fails
- Stores data in PostgreSQL database

### Infrastructure

- **Cloud Run Service**: Auto-scaling HTTP service
- **Cloud Scheduler Jobs**:
  - **Daily Sync**: Weekdays at 6 PM AEST (after market close)
  - **Weekly Backfill**: Sundays at 8 PM AEST (7-day historical data)
- **Service Account**: Access to Secret Manager for API keys

### Endpoints

- `POST /sync-all` - Sync all stocks
- `POST /sync` - Sync with custom parameters
- `GET /health` - Health check

### Environment Variables

- `ALPHA_VANTAGE_API_KEY` - From Secret Manager
- `DATABASE_URL` - From Secret Manager
- `PRIMARY_PROVIDER` - alpha_vantage
- `FALLBACK_PROVIDER` - yahoo_finance

### Local Development

```bash
cd services/stock-price-ingestion
./docker-build-push.sh
cd ../../terraform
make deploy-image ENV=dev
```

---

## 📦 Short Data Sync

**Module**: `modules/short-data-sync`

### What It Does

- Downloads daily short selling reports from ASIC
- Processes CSV files and normalizes data
- Stores raw CSV files in GCS bucket
- Loads processed data into PostgreSQL

### Infrastructure

- **Cloud Run Job**: Batch processing job
- **GCS Bucket**: Stores CSV files with versioning
- **Cloud Scheduler Job**: Triggers daily at 8 PM AEST
- **Service Account**: Access to GCS and Secret Manager

### GCS Bucket

- **Name**: `shorted-dev-aba5688f-short-selling-data`
- **Structure**:
  ```
  data/shorts/
    RR20250103-001-SSDailyAggShortPos.csv
    RR20250102-001-SSDailyAggShortPos.csv
    ...
  downloaded_files_index.json
  ```
- **Lifecycle**: 1 year retention
- **Versioning**: Enabled

### How It Works

1. Fetches available files list from ASIC API
2. Checks index to see which files are new
3. Downloads new CSV files to GCS
4. Processes files using Dask (parallel processing)
5. Normalizes data schema
6. Loads into `shorts` table in PostgreSQL
7. Updates index file

### Running Manually

```bash
# Trigger the job
gcloud run jobs execute short-data-sync \
  --region australia-southeast2 \
  --project shorted-dev-aba5688f

# View logs
gcloud logging read "resource.type=cloud_run_job" \
  --limit 50 \
  --project shorted-dev-aba5688f
```

---

## 📈 Shorts API

**Module**: `modules/shorts-api`

### What It Does

- Main API service for querying stock short position data
- Provides gRPC and Connect RPC endpoints
- Handles dashboard data and stock queries
- Integrates with market data service

### Infrastructure

- **Cloud Run Service**: Always-on, auto-scaling
- **Min Instances**: 1 (for low latency)
- **Max Instances**: 100
- **Service Account**: Access to database secrets

### Database Connection

- **Host**: Supabase Pooler (aws-0-ap-southeast-2.pooler.supabase.com)
- **Database**: postgres
- **Auth**: Username + password from Secret Manager

### Endpoints

- gRPC services defined in `proto/shortedapi/`
- Connect RPC compatible
- Health checks at `/health`

### Scaling

- **Min**: 1 instance (reduces cold starts)
- **Max**: 100 instances
- **CPU**: 2 vCPU
- **Memory**: 2 GiB

---

## 📝 CMS (Payload CMS)

**Module**: `modules/cms`

### What It Does

- Content management system for blog posts, metadata, and media
- Built on Payload CMS (Node.js)
- Manages stock metadata and images
- Provides admin interface

### Infrastructure

- **Cloud Run Service**: Auto-scaling Node.js app
- **Port**: 3000
- **Service Account**: Access to MongoDB secret (if configured)

### Configuration

- **Database**: MongoDB (connection via Secret Manager)
- **Media Storage**: Local or GCS (configurable)
- **Admin Panel**: `/admin`
- **API**: `/api/*`

### Environment Variables

- `NODE_ENV` - production/development
- `MONGODB_URI` - From Secret Manager (optional)
- `PAYLOAD_PUBLIC_SERVER_URL` - Public URL for CMS
- `PAYLOAD_CONFIG_PATH` - dist/payload.config.js

### Collections

- **Media**: Images and files
- **Metadata**: Stock company metadata
- **Users**: CMS admin users

---

## 🔐 Security & IAM

### Service Accounts

Each service has its own service account with minimal permissions:

| Service               | Permissions                                     |
| --------------------- | ----------------------------------------------- |
| stock-price-ingestion | Secret Manager (API keys, DB)                   |
| short-data-sync       | Secret Manager (DB), Storage Admin (GCS bucket) |
| shorts                | Secret Manager (DB password)                    |
| cms                   | Secret Manager (MongoDB)                        |

### Secrets Used

- `ALPHA_VANTAGE_API_KEY` - Alpha Vantage API key
- `DATABASE_URL` - PostgreSQL connection string
- `APP_STORE_POSTGRES_PASSWORD` - Postgres password
- `MONGODB_URI` - MongoDB connection (CMS, optional)

### Creating Secrets

```bash
# Create a new secret
echo -n "secret-value" | gcloud secrets create SECRET_NAME \
  --data-file=- \
  --project=shorted-dev-aba5688f

# Grant access to a service account
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="serviceAccount:SERVICE_NAME@shorted-dev-aba5688f.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=shorted-dev-aba5688f
```

---

## 📅 Scheduled Jobs

| Job                                   | Service     | Schedule      | Description                   |
| ------------------------------------- | ----------- | ------------- | ----------------------------- |
| stock-price-ingestion-daily-sync      | Stock Price | 0 8 \* \* 1-5 | Daily stock prices (weekdays) |
| stock-price-ingestion-weekly-backfill | Stock Price | 0 10 \* \* 0  | Weekly 7-day backfill         |
| short-data-sync-daily                 | Short Data  | 0 10 \* \* \* | Daily ASIC short data         |

All times are in UTC. Australian times:

- 0 8 UTC = 6 PM AEST / 7 PM AEDT
- 0 10 UTC = 8 PM AEST / 9 PM AEDT

---

## 🛠 Deployment

### Deploy All Services

```bash
cd terraform/environments/dev
terraform apply
```

### Deploy Specific Service

```bash
# Stock price ingestion
terraform apply -target=module.stock_price_ingestion

# Short data sync
terraform apply -target=module.short_data_sync

# Shorts API
terraform apply -target=module.shorts_api

# CMS
terraform apply -target=module.cms
```

### Build and Deploy New Image

```bash
# 1. Build and push Docker image
cd services/stock-price-ingestion  # or any service
./docker-build-push.sh

# 2. Update Terraform to use new image
cd ../../terraform
make deploy-image ENV=dev
```

---

## 📊 Monitoring

### View Logs

```bash
# Stock price ingestion
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=stock-price-ingestion" --limit 50

# Short data sync job
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=short-data-sync" --limit 50

# Shorts API
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=shorts" --limit 50

# CMS
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=cms" --limit 50
```

### View Scheduler Jobs

```bash
gcloud scheduler jobs list --project=shorted-dev-aba5688f

# View job details
gcloud scheduler jobs describe JOB_NAME \
  --location=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

### Trigger Manual Execution

```bash
# Trigger scheduler job
gcloud scheduler jobs run stock-price-ingestion-daily-sync \
  --location=australia-southeast2 \
  --project=shorted-dev-aba5688f

# Execute Cloud Run job directly
gcloud run jobs execute short-data-sync \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

---

## 🆘 Troubleshooting

### Service Not Starting

```bash
# Check service logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=SERVICE_NAME" --limit 50

# Check service details
gcloud run services describe SERVICE_NAME \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

### Scheduler Job Not Running

```bash
# Check job status
gcloud scheduler jobs describe JOB_NAME \
  --location=australia-southeast2

# View recent executions
gcloud logging read "resource.type=cloud_scheduler_job AND resource.labels.job_id=JOB_NAME" --limit 10
```

### Permission Errors

```bash
# Check service account permissions
gcloud projects get-iam-policy shorted-dev-aba5688f \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:SERVICE_NAME@shorted-dev-aba5688f.iam.gserviceaccount.com"
```

### Import Existing Resources

If resources were created manually:

```bash
cd terraform/environments/dev

# Import Cloud Run service
terraform import module.shorts_api.google_cloud_run_v2_service.shorts_api \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/services/shorts

# Import Cloud Scheduler job
terraform import module.stock_price_ingestion.google_cloud_scheduler_job.daily_sync \
  projects/shorted-dev-aba5688f/locations/australia-southeast2/jobs/stock-price-ingestion-daily-sync
```

---

## 📚 Additional Resources

- [Terraform Module Documentation](README.md)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud Scheduler Documentation](https://cloud.google.com/scheduler/docs)
- [Stock Price Ingestion Service](../../services/stock-price-ingestion/README.md)
