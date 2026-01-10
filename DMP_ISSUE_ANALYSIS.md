# DMP Historical Data Issue Analysis

## Problem

DMP (one of the top shorted stocks) shows "no data found" error when trying to sync.

## Root Cause

The error shows: `yahoo finance returned no data for DMP.AX in date range 2026-01-03 to 2026-01-03`

**Analysis:**
1. DMP already has data in the database up to **2026-01-02** (yesterday)
2. Sync logic calculates: `startDate = latestDate + 1 day = 2026-01-03` (today)
3. Sync requests data from **2026-01-03 to 2026-01-03** (today only)
4. Yahoo Finance doesn't have today's data yet (market may not be closed, or it's a weekend/holiday)
5. Yahoo Finance's latest data for DMP.AX is **2026-01-02** (yesterday)

## Solution Implemented

### 1. Date Range Adjustment in Yahoo Provider (`yahoo_direct.go`)
- When requesting today's data, adjust `startDate` to yesterday
- Adjust `endDate` to end of yesterday
- This allows fetching yesterday's data when today isn't available yet

### 2. Date Range Adjustment in Sync Logic (`sync.go`)
- If `startDate` is today, adjust `endDate` to end of yesterday
- This prevents requesting data that doesn't exist yet

### 3. Historical Backfill Tool (`cmd/historical-backfill`)
- Created separate tool for one-time historical data backfill
- Can be run locally to populate historical data
- Production service then handles incremental updates only

## Verification

**Yahoo Finance has DMP data:**
```bash
curl "https://query1.finance.yahoo.com/v8/finance/chart/DMP.AX?interval=1d&range=1mo"
# Returns 22 timestamps (22 days of data)
# Latest: 2026-01-02 (yesterday)
```

**The issue:** When DMP has data up to yesterday, we try to fetch today's data, which doesn't exist yet.

## Fix Status

✅ **Code fixes applied:**
- `yahoo_direct.go`: Adjusts date range to accept yesterday's data when requesting today
- `sync.go`: Adjusts endDate when requesting today's data
- Historical backfill tool created for one-time data population

⏳ **Deployment:** In progress (waiting for image push to complete)

## Next Steps

1. **Deploy date fix** to production
2. **Test DMP sync** - should now fetch yesterday's data successfully
3. **Run historical backfill** locally if needed to populate missing historical data
4. **Monitor** daily syncs to ensure incremental updates work correctly

## Historical Backfill Tool

For one-time historical data population:

```bash
cd services/market-data-sync
go run ./cmd/historical-backfill -years=10
```

This will:
- Fetch 10 years of historical data for all stocks
- Respect rate limits (4 seconds between requests)
- Skip stocks that already have sufficient data
- Take ~2-3 hours for all stocks

After backfill, production service handles incremental daily updates.
