# Stock Price Ingestion Service

Cloud Run service for automated synchronization of ASX stock prices from Yahoo Finance to Supabase/PostgreSQL.

## Overview

This service provides automated daily ingestion of stock market data for Australian Stock Exchange (ASX) listed companies. It runs on Google Cloud Run and is triggered by Cloud Scheduler to ensure consistent, reliable data updates.

## Features

- **Automated Daily Sync**: Scheduled to run after ASX market close (6 PM AEST)
- **Yahoo Finance Integration**: Fetches OHLCV data from Yahoo Finance
- **Data Validation**: Built-in validation for price relationships and anomaly detection
- **Circuit Breaker Pattern**: Protects against API failures with automatic recovery
- **Batch Processing**: Efficient bulk inserts with PostgreSQL COPY
- **Error Recovery**: Automatic retry with exponential backoff
- **Data Quality Tracking**: Logs anomalies and missing data for monitoring

## Architecture

```
Cloud Scheduler → Cloud Run Service → Yahoo Finance API
                        ↓
                   Supabase PostgreSQL
```

## Deployment

### Prerequisites

1. Google Cloud Project with billing enabled
2. Supabase project with database configured
3. gcloud CLI installed and authenticated

### Environment Variables

```bash
DATABASE_URL=postgresql://user:pass@host:5432/database
GCP_PROJECT=shorted-dev-aba5688f
ENVIRONMENT=production
```

### Deploy to Cloud Run

```bash
# Deploy service and set up scheduler
make deploy

# Or manually
./deploy.sh
```

This will:

1. Build and push Docker image to Container Registry
2. Deploy service to Cloud Run
3. Create Cloud Scheduler jobs for automated sync
4. Configure IAM permissions

## Usage

### Automated Sync (Production)

The service runs automatically via Cloud Scheduler:

- **Daily Sync**: Weekdays at 6 PM AEST (after market close)
- **Weekly Backfill**: Sundays at 8 PM AEST (comprehensive sync)

### Manual Sync

```bash
# Trigger daily sync
make trigger-sync

# Trigger 30-day backfill
make trigger-backfill

# Custom sync via API
curl -X POST https://stock-price-ingestion-xxx.run.app/sync \
  -H "Content-Type: application/json" \
  -d '{
    "symbols": ["CBA.AX", "BHP.AX"],
    "start_date": "2024-01-01",
    "end_date": "2024-01-31",
    "mode": "backfill"
  }'
```

### Local Development

```bash
# Install dependencies
make install

# Run locally (without Docker)
make run-dev

# Run with Docker
make build
make run-local

# Run tests
make test
```

## API Endpoints

### `GET /health`

Health check endpoint for Cloud Run monitoring.

### `POST /sync-all`

Sync all configured ASX stocks (called by scheduler).

### `POST /sync`

Custom sync with specific parameters.

**Request Body:**

```json
{
  "symbols": ["CBA.AX", "BHP.AX"],
  "start_date": "2024-01-01",
  "end_date": "2024-01-31",
  "days_back": 7,
  "mode": "update"
}
```

### `GET /status/{batch_id}`

Check status of a sync job.

## Data Schema

### stock_prices table

```sql
CREATE TABLE stock_prices (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2),
    adjusted_close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);
```

### stock_data_ingestion_log table

```sql
CREATE TABLE stock_data_ingestion_log (
    id SERIAL PRIMARY KEY,
    batch_id UUID,
    data_source VARCHAR(50),
    start_date DATE,
    end_date DATE,
    stocks_processed INTEGER,
    records_inserted INTEGER,
    records_updated INTEGER,
    errors INTEGER,
    error_details JSONB,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    status VARCHAR(20)
);
```

## Monitoring

### View Logs

```bash
# Recent logs
make logs

# Filter by severity
gcloud logging read "resource.labels.service_name=stock-price-ingestion AND severity>=ERROR" --limit=20

# Check ingestion stats
make db-check-data
```

### Health Checks

```bash
# Service health
make health-check

# Database connection
make db-test-connection
```

### Metrics to Monitor

1. **Ingestion Success Rate**: Track completed vs failed syncs
2. **Data Completeness**: Verify all expected stocks have data
3. **Latency**: Monitor sync duration
4. **Error Rate**: Track API failures and retries
5. **Data Quality**: Monitor anomaly detection triggers

## Troubleshooting

### Common Issues

#### 1. Yahoo Finance Rate Limiting

- **Symptom**: 429 errors or timeouts
- **Solution**: Circuit breaker will automatically back off and retry

#### 2. Missing Data for Weekends/Holidays

- **Symptom**: No data for certain dates
- **Solution**: This is expected - markets are closed

#### 3. Database Connection Errors

- **Symptom**: asyncpg connection failures
- **Solution**: Check DATABASE_URL and network connectivity

#### 4. Memory Issues

- **Symptom**: Cloud Run instance crashes
- **Solution**: Increase memory limit in cloudbuild.yaml

### Manual Recovery

```bash
# Re-run failed daily sync
gcloud scheduler jobs run stock-price-daily-sync --location=australia-southeast2

# Backfill missing data
curl -X POST [SERVICE_URL]/sync \
  -d '{"start_date": "2024-01-01", "end_date": "2024-01-31", "mode": "backfill"}'
```

## Performance

- **Throughput**: ~50 stocks/minute with 5 concurrent workers
- **Latency**: < 2 seconds per stock (typical)
- **Resource Usage**: 1 CPU, 1GB RAM
- **Cost**: ~$5-10/month on Cloud Run (with daily syncs)

## Security

- Service account with minimal permissions
- Database credentials stored in Secret Manager
- No public access (scheduler only)
- Input validation on all endpoints
- SQL injection protection via parameterized queries

## Development

### Adding New Data Sources

1. Implement new fetcher in `data_sources/` directory
2. Add to `StockDataIngestion` class
3. Update circuit breaker configuration
4. Add data source to ingestion log

### Testing

```bash
# Unit tests
pytest tests/unit -v

# Integration tests
pytest tests/integration -v

# Load testing
locust -f tests/load/locustfile.py
```

## License

Proprietary - Shorted.com.au

## Support

For issues or questions, contact the development team or create an issue in the repository.
