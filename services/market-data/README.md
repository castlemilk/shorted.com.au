# Market Data Sync Service

Cloud Run service for automated daily synchronization of ASX stock prices from Yahoo Finance to Supabase/PostgreSQL.

## Overview

This service provides automated daily ingestion of stock market data for Australian Stock Exchange (ASX) listed companies. It runs on Google Cloud Run and is triggered by Cloud Scheduler to ensure consistent, reliable data updates.

## Features

- **Automated Daily Sync**: Scheduled to run after ASX market close (6 PM AEST)
- **Yahoo Finance Integration**: Fetches OHLCV data from Yahoo Finance using batch downloads
- **Optimized Performance**: Processes 1,800+ stocks in ~10 minutes using batch API calls
- **Rate Limiting Protection**: Uses batch downloads to avoid Yahoo Finance rate limits
- **Error Recovery**: Automatic retry with exponential backoff
- **Data Quality**: Validates data integrity and handles missing values

## Architecture

```
Cloud Scheduler → Cloud Run Service → Yahoo Finance API (Batch)
                        ↓
                   Supabase PostgreSQL
```

## Quick Start

### Prerequisites

1. Google Cloud Project with billing enabled
2. Supabase project with database configured
3. gcloud CLI installed and authenticated

### Environment Variables

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/database"
export GCP_PROJECT="your-project-id"  # Optional, defaults to shorted-prod
```

### Deploy to Cloud Run

```bash
# Quick deployment
make deploy

# Or manually
./deploy.sh
```

This will:

1. Build and push Docker image to Container Registry
2. Deploy service to Cloud Run
3. Create Cloud Scheduler job for automated sync
4. Configure IAM permissions

## Usage

### Automated Sync (Production)

The service runs automatically via Cloud Scheduler:

- **Daily Sync**: Weekdays at 6 PM AEST (after market close)
- **Batch Processing**: 100 stocks per batch to avoid rate limits

### Manual Sync

```bash
# Trigger daily sync
curl -X POST [SERVICE_URL]/sync

# Run sync immediately (for testing)
curl -X POST [SERVICE_URL]/sync-now

# Check service health
curl [SERVICE_URL]/health
```

### Local Testing

```bash
# Install dependencies
make install

# Test configuration
python test_deployment.py

# Test locally (requires DATABASE_URL)
make test-local
```

## Performance

- **Throughput**: ~1,800 stocks in ~10 minutes
- **API Efficiency**: 18 API calls vs 1,800 individual calls
- **Rate Limiting**: Safe from Yahoo Finance limits
- **Resource Usage**: 1 CPU, 1GB RAM
- **Cost**: ~$2-5/month on Cloud Run

## Monitoring

### View Logs

```bash
make logs
# or
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-sync" --limit 50
```

### Health Checks

```bash
make health
# or
curl [SERVICE_URL]/health
```

### Manual Recovery

```bash
# Re-run failed sync
gcloud scheduler jobs run market-data-daily-sync --location=australia-southeast1
```

## Troubleshooting

### Common Issues

#### 1. Yahoo Finance Rate Limiting

- **Symptom**: No data fetched for batches
- **Solution**: Batch size is optimized (100 stocks) to stay under limits

#### 2. Database Connection Errors

- **Symptom**: Connection failures in logs
- **Solution**: Check DATABASE_URL and network connectivity

#### 3. Memory Issues

- **Symptom**: Cloud Run instance crashes
- **Solution**: Service is configured with 1GB RAM (should be sufficient)

### Debug Locally

```bash
# Test with sample data
export DATABASE_URL="your-database-url"
python test_deployment.py

# Run sync manually
python daily_sync_optimized.py
```

## Security

- Service account with minimal permissions
- Database credentials in environment variables
- No public access (scheduler only)
- Input validation on all endpoints

## Development

### Adding Features

1. Modify `cloud_run_service.py` for new endpoints
2. Update `daily_sync_optimized.py` for sync logic
3. Test locally with `make test-local`
4. Deploy with `make deploy`

### Docker Development

```bash
# Build locally
docker build -t market-data-sync .

# Run locally
docker run -p 8080:8080 \
  -e DATABASE_URL="your-database-url" \
  market-data-sync
```

## API Reference

### Endpoints

- `GET /` - Service information
- `GET /health` - Health check
- `POST /sync` - Trigger daily sync (scheduled)
- `POST /sync-now` - Run sync immediately (for testing)

### Response Format

```json
{
  "status": "completed",
  "message": "Sync completed for 1803 stocks",
  "records_processed": 1803,
  "batch_id": "manual-sync-1699123456"
}
```
