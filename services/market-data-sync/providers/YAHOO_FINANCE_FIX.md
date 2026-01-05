# Yahoo Finance API Fix

## Problem Solved ✅

The `piquette/finance-go` library (v1.1.0) was broken due to Yahoo Finance API changes. We've implemented a direct HTTP client that bypasses the broken library.

## Solution

Created `YahooFinanceDirectProvider` that makes direct HTTP requests to Yahoo Finance's v8 API endpoint:

```
https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=1d&range={RANGE}
```

## Implementation Details

### API Endpoint
- **URL**: `https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}`
- **Method**: GET
- **Parameters**:
  - `interval`: `1d` (daily data)
  - `range`: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max`
  - `includePrePost`: `false`

### Response Structure
```json
{
  "chart": {
    "result": [{
      "meta": { "symbol": "BHP.AX", ... },
      "timestamp": [1764630000, ...],
      "indicators": {
        "quote": [{
          "open": [42.9, ...],
          "high": [42.9, ...],
          "low": [42.39, ...],
          "close": [42.56, ...],
          "volume": [7321330, ...]
        }],
        "adjclose": [{
          "adjclose": [42.56, ...]
        }]
      }
    }]
  }
}
```

### Features
- ✅ Direct HTTP client (no external library dependency)
- ✅ Proper User-Agent header to mimic browser requests
- ✅ Date range filtering
- ✅ Support for adjusted close prices
- ✅ Error handling with detailed error messages
- ✅ Rate limiting (2 seconds between requests)

## Testing

All integration tests pass:
- ✅ BHP: 19 records (30 days)
- ✅ CBA: 5 records (7 days)
- ✅ Multiple stocks (BHP, CBA, ANZ, WBC, NAB)
- ✅ Long date ranges (1 year: 253 records)
- ✅ Date range filtering
- ✅ .AX suffix handling

## Usage

The provider is automatically used in `main.go`:

```go
dataProviders = append(dataProviders, providers.NewYahooFinanceDirectProvider())
```

The old `YahooFinanceProvider` (using piquette/finance-go) is kept for reference but not used.

## Benefits

1. **No External Dependency**: Direct HTTP calls, no broken library
2. **Reliable**: Works with current Yahoo Finance API
3. **Maintainable**: Full control over API calls
4. **Fast**: Direct requests, no library overhead
5. **Tested**: Comprehensive integration tests

## Migration Notes

- Old provider (`YahooFinanceProvider`) still exists but is not used
- New provider (`YahooFinanceDirectProvider`) is the default
- Same interface, so no changes needed in sync code
- Rate limiting remains the same (2 seconds)

## Future Improvements

1. Add caching for frequently requested symbols
2. Implement retry logic with exponential backoff
3. Add metrics/monitoring for API call success rates
4. Consider adding support for intraday data (if needed)
