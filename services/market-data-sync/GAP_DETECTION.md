# Gap Detection and Repair

## Overview

The market-data-sync service now includes automatic gap detection and repair functionality to ensure continuous historical price data.

## How Gaps Occur

Gaps in stock price data can occur due to:

1. **API Failures** - If Yahoo Finance returns an error for certain dates, those days are skipped
2. **Rate Limiting** - Mid-sync rate limits can cause partial data loss
3. **Service Restarts** - If sync is interrupted, some dates are never retried
4. **Chunked Requests** - When fetching 10 years of data in chunks, some chunks might fail
5. **Data Availability** - Some dates might not have been available when originally fetched

## Gap Detection

The gap detector identifies missing data by comparing consecutive dates in the database. A gap is defined as:
- More than 4 consecutive calendar days missing (to account for weekends + buffer)
- Customizable via `minGapDays` parameter

### SQL Query Used

```sql
WITH date_series AS (
    SELECT 
        date,
        LAG(date) OVER (ORDER BY date) as prev_date
    FROM stock_prices
    WHERE stock_code = $1
),
gaps AS (
    SELECT 
        prev_date as gap_start,
        date as gap_end,
        (date - prev_date) as gap_days
    FROM date_series
    WHERE prev_date IS NOT NULL
      AND (date - prev_date) > $2
)
SELECT gap_start, gap_end, gap_days FROM gaps
```

## API Endpoints

### Detect Gaps for a Stock
```
GET /api/gaps/detect/{symbol}?minGapDays=4
```

Returns:
```json
{
  "stock_code": "DMP",
  "min_gap_days": 4,
  "gaps_found": 1,
  "gaps": [
    {
      "StockCode": "DMP",
      "StartDate": "2025-10-14",
      "EndDate": "2025-11-27",
      "Days": 44
    }
  ]
}
```

### Repair Gaps for a Stock
```
POST /api/gaps/repair/{symbol}?minGapDays=4
```

Returns:
```json
{
  "stock_code": "DMP",
  "status": "repaired",
  "gaps_found": 1,
  "records_repaired": 32
}
```

### Get Gap Report
```
GET /api/gaps/report/{symbol}?minGapDays=4
```

Returns detailed report including:
- Total gaps
- Total missing days
- Earliest/latest data dates
- Total records

### Detect All Gaps
```
GET /api/gaps/detect-all?minGapDays=4
```

Scans all stocks and returns gaps for each.

## Automatic Gap Repair

The sync process now automatically detects and repairs gaps:

1. **During Regular Sync**: After fetching new data for a stock, the service checks for gaps and repairs them
2. **When Already Up-to-Date**: If a stock has no new data to fetch, the service still checks for and repairs gaps
3. **Rate Limited**: Gap repairs are rate-limited to avoid overwhelming Yahoo Finance

### Code Flow

```go
func (m *SyncManager) syncStock(ctx context.Context, symbol string) (int, error) {
    // 1. Fetch new incremental data
    records := fetchNewData(symbol, startDate, endDate)
    
    // 2. Upsert records
    upsertRecords(records)
    
    // 3. Check for and repair gaps
    gapRecords := m.repairGapsIfNeeded(ctx, symbol)
    
    return len(records) + gapRecords, nil
}
```

## Testing Gap Detection

```bash
# Test on production
curl -X GET "https://market-data-sync-xxx.run.app/api/gaps/detect/DMP"

# Repair gaps
curl -X POST "https://market-data-sync-xxx.run.app/api/gaps/repair/DMP"

# Generate report
curl -X GET "https://market-data-sync-xxx.run.app/api/gaps/report/DMP"
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minGapDays` | 4 | Minimum consecutive missing days to be considered a gap |

## Future Improvements

1. **Scheduled Gap Scan**: Add a scheduled job to scan all stocks for gaps weekly
2. **Gap Alerts**: Send notifications when significant gaps are detected
3. **Historical Validation**: Compare data counts against expected trading days
4. **Parallel Repair**: Repair gaps in parallel for faster processing
