# Checkpoint-Based Batch Processing System

## Overview

The daily sync job now uses a checkpoint system to process stocks in batches, allowing it to:

- Process stocks in configurable batch sizes (default: 500)
- Resume from where it left off if interrupted
- Track which stocks have been successfully updated
- Retry until all stocks are processed

## How It Works

### 1. Daily Checkpoint Tracking

Each day, the sync job:

1. Checks for an existing incomplete sync run from today
2. If found, resumes from the last checkpoint
3. If not found, creates a new sync run

### 2. Batch Processing

- Processes up to `SYNC_BATCH_SIZE` stocks per run (default: 500)
- Updates checkpoint after each stock (batched every 10 stocks to reduce DB load)
- Tracks:
  - `checkpoint_stocks_processed`: All stocks attempted
  - `checkpoint_stocks_successful`: Stocks successfully updated
  - `checkpoint_stocks_failed`: Stocks that failed
  - `checkpoint_resume_from`: Index to resume from

### 3. Status Tracking

- `running`: Currently processing
- `partial`: Completed a batch but more stocks remain
- `completed`: All stocks processed
- `failed`: Job failed with error

### 4. Automatic Retries

Cloud Run will automatically retry failed jobs (up to 2 retries by default). Each retry:

- Resumes from the last checkpoint
- Skips already successfully processed stocks
- Continues until all stocks are processed or timeout

## Database Schema

### New Columns in `sync_status`:

- `checkpoint_stocks_processed TEXT[]`: Array of stock codes processed
- `checkpoint_stocks_total INTEGER`: Total stocks to process
- `checkpoint_stocks_successful TEXT[]`: Successfully updated stocks
- `checkpoint_stocks_failed TEXT[]`: Failed stocks
- `checkpoint_batch_size INTEGER`: Stocks per batch (default: 500)
- `checkpoint_resume_from INTEGER`: Index to resume from

### New Table: `daily_sync_progress`

Tracks individual stock sync progress per day (for future detailed tracking).

## Configuration

### Environment Variables

- `SYNC_BATCH_SIZE`: Number of stocks to process per batch (default: 500)
- `SYNC_DAYS_STOCK_PRICES`: Days of price data to sync (default: 5)
- `SYNC_DAYS_SHORTS`: Days of shorts data to sync (default: 7)

### Batch Size Calculation

With default settings:

- 500 stocks per batch
- ~5 seconds per stock (with rate limiting)
- ~42 minutes per batch (well under 1-hour timeout)
- ~4 batches needed for 1843 stocks total

## Migration

Run the migration to add checkpoint support:

```bash
# Apply migration
psql $DATABASE_URL -f services/migrations/000007_add_sync_checkpoint.up.sql
```

## Monitoring

Check sync progress:

```bash
python3 scripts/check-sync-status.py
```

Or query directly:

```sql
SELECT
    run_id,
    started_at,
    status,
    checkpoint_resume_from,
    checkpoint_stocks_total,
    array_length(checkpoint_stocks_processed, 1) as processed_count,
    array_length(checkpoint_stocks_successful, 1) as successful_count,
    array_length(checkpoint_stocks_failed, 1) as failed_count
FROM sync_status
WHERE DATE(started_at) = CURRENT_DATE
ORDER BY started_at DESC;
```

## Benefits

1. **No More Timeouts**: Jobs complete within 1-hour limit
2. **Resumable**: Automatically resumes from checkpoint on retry
3. **Progress Tracking**: Know exactly which stocks are processed
4. **Efficient**: Skips already processed stocks
5. **Reliable**: Tracks successes and failures separately


