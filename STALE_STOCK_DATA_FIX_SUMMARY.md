# Stale Stock Data Fix - Implementation Summary

## Issue Identified

**Stock:** MAM (Microequities Asset Management Group Limited)  
**Problem:** Displaying 95% short position from February 2, 2011 (13+ years old)  
**Root Cause:** Industry treemap query had no data freshness filter, allowing delisted/inactive stocks with extreme historical short positions to appear prominently

## Impact Analysis

**Before Fix:**

- **2,483 stocks** with stale data (older than 6 months from latest data)
- MAM ranked #1 in Financial Services with 95% short position from 2011
- Oldest stale data from June 17, 2010
- Misleading visualization showing inactive stocks as top shorts

**After Fix:**

- **1,357 active stocks** with recent data (within 6 months)
- All stale stocks excluded from treemap
- MAM and similar delisted stocks no longer displayed
- More accurate representation of current market conditions

## Changes Implemented

### 1. Backend SQL Query Updates

**File:** `services/shorts/internal/store/shorts/getShortsTreeMap.go`

#### A. Current Shorts Query (lines 149-161)

Added data freshness filter using `HAVING` clause:

```sql
HAVING MAX("DATE") >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
```

#### B. Percentage Change Query (lines 84-96)

Added filter in `latest_data` CTE:

```sql
AND "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
```

**Rationale:** 6-month threshold ensures:

- Active stocks with regular reporting remain visible
- Delisted stocks automatically excluded
- Works with all period views (1M, 3M, MAX, etc.)

### 2. Frontend Tooltip Enhancement

**File:** `web/src/@/components/widgets/treemap-tooltip.tsx`

Added "Last Updated" indicator (lines 246-260) to display data freshness:

```typescript
{
  sparklineData.length > 0 && (
    <div className="pt-2 border-t border-border">
      <p className="text-xs text-muted-foreground">
        Last updated:{" "}
        {new Date(
          sparklineData[sparklineData.length - 1]!.date
        ).toLocaleDateString("en-AU", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}
      </p>
    </div>
  );
}
```

**Benefits:**

- Transparency about data age
- Users can assess data reliability
- Australian date format for local market

## Testing Results

### Test 1: MAM Exclusion ✓

```bash
# Before: MAM returned with 95% short position
# After: MAM not in results (empty output)
curl -s [...] | jq '.stocks[] | select(.productCode == "MAM")'
# Output: (empty)
```

### Test 2: Active Stocks Verified ✓

```bash
# Sample stocks all have recent data (2024-05-30)
- ABB: 2.60% (Telecommunication Services)
- OBL: 6.36% (Financial Services)
- All dates: 2024-05-30
```

### Test 3: Stock Count Reasonable ✓

```bash
# MAX period: 236 stocks across all industries
# 3M period: 233 stocks
# All within reasonable ranges
```

### Test 4: Cross-Period Verification ✓

- Tested with periods: MAX, 3M, 1M
- MAM excluded in all views
- Active stocks appear consistently

### Test 5: Financial Services Sector ✓

```bash
# Before: MAM (95%) dominated sector
# After: Top stocks range from 2-6% (normal range)
OBL: 6.36%, IFL: 5.54%, MAF: 3.36%, etc.
```

## Data Validation

### Database Verification

```sql
-- Latest data in system
SELECT MAX("DATE") FROM shorts;
-- Result: 2024-05-30

-- MAM last reported
SELECT MAX("DATE") FROM shorts WHERE "PRODUCT_CODE" = 'MAM';
-- Result: 2011-02-02 (EXCLUDED ✓)

-- Active stocks shown
SELECT COUNT(*) FROM (
  SELECT "PRODUCT_CODE", MAX("DATE") as last_date
  FROM shorts
  GROUP BY "PRODUCT_CODE"
  HAVING MAX("DATE") >= '2024-05-30'::date - INTERVAL '6 months'
) active;
-- Result: 1,357 stocks
```

## Benefits

1. **Accuracy:** Treemap now shows only actively reporting stocks
2. **Relevance:** Data within 6 months of latest reporting date
3. **Transparency:** Users can see when data was last updated
4. **Automatic:** Stale stocks automatically excluded as they age
5. **Performance:** Reduced dataset improves query performance

## Edge Cases Considered

1. **Delisted stocks:** Automatically excluded after 6 months
2. **Reporting gaps:** Stocks with >6 month gaps treated as inactive
3. **Period views:** Filter applies consistently across all time periods
4. **Industry ranking:** Rankings recalculated with only active stocks

## Monitoring Recommendations

1. **Regular audits:** Check for stocks near 6-month threshold
2. **Data quality:** Monitor for unexpected reporting gaps
3. **User feedback:** Track if 6-month threshold needs adjustment
4. **Stock counts:** Ensure reasonable number of stocks shown per sector

## Conclusion

The fix successfully addresses the issue of stale stock data in the industry treemap by:

- Filtering out 2,483 stale stocks (65% of total)
- Maintaining 1,357 active stocks (35% of total)
- Adding transparency through "Last Updated" indicator
- Providing accurate, current market view for users

MAM and all other stocks with data older than 6 months are now correctly excluded from the visualization.

---

**Implementation Date:** November 4, 2025  
**Files Modified:** 2  
**Tests Passed:** 5/5  
**Status:** ✅ Complete
