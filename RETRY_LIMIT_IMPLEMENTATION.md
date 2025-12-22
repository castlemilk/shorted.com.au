# Retry Limit and Rate Limiting Implementation

## Overview

The checkpoint system now includes intelligent retry limits and rate limiting to gracefully handle:

- **Rate limiting** from APIs (Alpha Vantage, Yahoo Finance)
- **Broken/removed stocks** that fail repeatedly
- **Temporary API issues** vs permanent failures

## Features

### 1. Per-Stock Retry Limits

- **Configuration**: `MAX_STOCK_FAILURE_RETRIES=3` (default: 3)
- **Behavior**: After a stock fails 3 times, it's marked as "permanently failed"
- **Result**: Permanently failed stocks are skipped in future runs
- **Reset**: If a permanently failed stock succeeds later, its failure count is reset

### 2. Failure Tracking

- **Failure Count**: Tracked per stock in `checkpoint_data["stocks_failed_count"]`
- **Persistence**: Failure counts are reconstructed from `stocks_failed` list on resume
- **Logging**: Shows failure count in logs (e.g., "failure 2/3")

### 3. Rate Limiting Protection

#### Alpha Vantage

- **Delay**: 12 seconds between calls (5 calls/minute limit)
- **Fixed**: No backoff needed (premium API with known limits)

#### Yahoo Finance

- **Base Delay**: 1 second between requests
- **Exponential Backoff**: On consecutive failures:
  - After 3 failures: delay increases by 1.5x
  - Max delay: 30 seconds
  - Resets on success
- **Circuit Breaker**: Logs warning every 10 consecutive failures

### 4. Smart Skipping

The system now skips:

1. ✅ **Successfully processed stocks** (already updated today)
2. ✅ **Permanently failed stocks** (exceeded max retries)
3. ✅ **Up-to-date stocks** (already have today's data)

## Configuration

### Environment Variables

```bash
MAX_STOCK_FAILURE_RETRIES=3  # Max retries per stock before permanent skip
SYNC_BATCH_SIZE=500          # Stocks per batch
RATE_LIMIT_DELAY_ALPHA=12.0  # Alpha Vantage delay (seconds)
RATE_LIMIT_DELAY_YAHOO=1.0   # Yahoo Finance base delay (seconds)
RATE_LIMIT_DELAY_YAHOO_MAX=30.0  # Max backoff delay (seconds)
CONSECUTIVE_FAILURES_BACKOFF_THRESHOLD=3  # Start backoff after N failures
```

## How It Works

### Example Flow

1. **First Failure**:

   ```
   [  42/1843] XYZ: ⚠️  No data from any source (failure 1/3)
   ```

2. **Second Failure** (next run):

   ```
   [  42/1843] XYZ: ⚠️  No data from any source (failure 2/3)
   ```

3. **Third Failure** (next run):

   ```
   [  42/1843] XYZ: ⛔ Permanently failed (3/3 failures) - will skip in future runs
   ```

4. **Future Runs**:
   ```
   [  42/1843] XYZ: ⛔ Permanently failed (3 failures, max: 3) - skipping
   ```

### Rate Limiting Example

```
⚠️  13 consecutive failures, backing off to 22.5s delay (rate limit protection)
```

This indicates:

- 13 stocks in a row failed
- Delay increased to 22.5s (from 1s base)
- System is protecting against rate limits

## Benefits

1. **No Infinite Retries**: Broken stocks are skipped after 3 attempts
2. **Rate Limit Protection**: Exponential backoff prevents API bans
3. **Efficient Processing**: Skips known-bad stocks quickly
4. **Self-Healing**: If a stock recovers, it's automatically retried
5. **Clear Logging**: Shows exactly why stocks are skipped

## Monitoring

Check permanently failed stocks:

```sql
SELECT
    run_id,
    started_at,
    array_length(checkpoint_stocks_failed, 1) as failed_count,
    checkpoint_stocks_failed
FROM sync_status
WHERE DATE(started_at) = CURRENT_DATE
  AND status IN ('running', 'partial', 'completed')
ORDER BY started_at DESC
LIMIT 1;
```

## Future Enhancements

Potential improvements:

- Track failure reasons (rate limit vs not found vs error)
- Different retry limits for different failure types
- Admin interface to manually reset failed stocks
- Alerting when too many stocks are permanently failed

