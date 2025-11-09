# Stock Historical Data Fix - Complete Summary

## Problem Identified

**Root Cause:** Stock code naming mismatch between tables

- `shorts` table uses codes WITHOUT `.AX` suffix (e.g., `IEL`)
- `stock_prices` table had codes WITH `.AX` suffix (e.g., `IEL.AX`)
- This prevented joins and lookups from working correctly

## What Was Fixed

### 1. Naming Standardization ✅

- Removed `.AX` suffix from all stock codes in `stock_prices`
- Deleted 36,061 duplicate records (where both versions existed)
- Updated 768,245 records to remove `.AX` suffix
- **Result:** All stock codes now consistent between tables

### 2. Data Coverage Improvement ✅

**Before Fix:**

- Total stocks in shorts: 3,338
- Stocks with price data: 91 (2.7%)
- IEL status: **NOT FOUND** ❌

**After Fix:**

- Total stocks in shorts: 3,338
- Stocks with price data: 1,528 (45.8%) ⬆️ **+1,437 stocks!**
- IEL status: **FOUND** ✅ (505 records, 2023-2025)

## Current Status

### ✅ Working

- IEL now has 505 historical price records (Aug 2023 - Aug 2025)
- 1,528 stocks total have price data
- No more `.AX` suffix mismatches
- Queries between `shorts` and `stock_prices` now work correctly

### ⚠️ Remaining Work

- **1,810 stocks** still need historical data (54.2%)
- These are mostly:
  - Smaller/less liquid stocks
  - Recently listed stocks
  - Stocks with non-standard tickers
  - Potentially delisted stocks

## Example Missing Stocks (Still Active)

- SDV, MYS, SHV, RWC, RML, NTU, NWS, PAC, PMT, OFX, NEU, OPT, PPK, MTS, ELV

## How to Populate Remaining Stocks

### Option 1: Populate All Remaining (Recommended)

```bash
cd services/market-data
source venv/bin/activate
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Run the populate script (will skip already-populated stocks)
python3 populate_all_asx_from_csv.py
```

**Note:** This will take ~15-30 minutes and may hit Yahoo Finance rate limits. The script has built-in rate limiting (0.5s delay between stocks).

### Option 2: Populate Specific Stocks

Use the `populate_specific_stocks.py` script for individual stocks:

```bash
# Edit the script to add your stocks:
# stocks_to_populate = ["SDV", "MYS", "RWC", ...]

python3 populate_specific_stocks.py
```

### Option 3: Wait for Daily Sync

Once deployed, the daily sync job will gradually fill in missing stocks:

```bash
make deploy-daily-sync
```

## Prevention

To prevent this issue in the future:

### 1. Update Populate Scripts

Ensure all populate scripts remove `.AX` suffix before inserting:

```python
# In populate_all_asx_from_csv.py (line 76)
stock_code = stock_code.replace('.AX', '')  # Remove .AX suffix
yf_ticker = f"{stock_code}.AX"  # Add it only for Yahoo Finance
```

### 2. Add Data Validation

Check for `.AX` suffixes in stock_prices:

```sql
-- This should return 0
SELECT COUNT(*) FROM stock_prices WHERE stock_code LIKE '%.AX';
```

### 3. Consistent Naming Convention

**Standard:** All stock codes in database should be WITHOUT `.AX` suffix

- `stock_prices.stock_code` = `IEL`
- `shorts.PRODUCT_CODE` = `IEL`
- Yahoo Finance ticker = `IEL.AX` (only used in API calls)

## Verification

### Check IEL is working:

```sql
-- IEL price data
SELECT COUNT(*), MIN(date), MAX(date)
FROM stock_prices
WHERE stock_code = 'IEL';

-- Expected: 505 records, 2023-08-11 to 2025-08-08
```

### Check overall coverage:

```sql
WITH shorts_stocks AS (
    SELECT DISTINCT "PRODUCT_CODE" as code
    FROM shorts
    WHERE "PRODUCT_CODE" IS NOT NULL
    AND LENGTH("PRODUCT_CODE") BETWEEN 3 AND 4
),
price_stocks AS (
    SELECT DISTINCT stock_code
    FROM stock_prices
)
SELECT
    COUNT(DISTINCT ss.code) as total,
    COUNT(DISTINCT ps.stock_code) as with_data,
    ROUND(100.0 * COUNT(DISTINCT ps.stock_code) / COUNT(DISTINCT ss.code), 1) as pct
FROM shorts_stocks ss
LEFT JOIN price_stocks ps ON ss.code = ps.stock_code;

-- Expected: ~1,528 with data (45.8%)
```

## Files Modified

1. ✅ `stock_prices` table - removed all `.AX` suffixes
2. ✅ Created `populate_specific_stocks.py` - for targeted stock population
3. ✅ This document - `STOCK_DATA_FIX_SUMMARY.md`

## Next Steps

1. **Immediate:** Test IEL page works: https://preview.shorted.com.au/shorts/IEL
2. **Short-term:** Populate remaining 1,810 stocks (Option 1 above)
3. **Long-term:** Deploy daily sync job to keep data current

---

**Status:** ✅ **IEL IS NOW AVAILABLE**  
**Impact:** 1,437 additional stocks now have historical data  
**Next:** Populate remaining 1,810 stocks for 100% coverage
