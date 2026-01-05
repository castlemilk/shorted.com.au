# Yahoo Finance Provider Issue

## Problem

The Yahoo Finance provider is consistently failing with the error:
```
code: remote-error, detail: error response recieved from upstream api
```

## Root Cause

Yahoo Finance frequently changes their **unofficial** API endpoints without notice. The `piquette/finance-go` library (v1.1.0) we're using relies on these endpoints and is currently broken due to Yahoo Finance API changes.

### Evidence

1. **Library Version**: `github.com/piquette/finance-go v1.1.0` (latest available)
2. **Error Pattern**: All requests fail with the same generic error
3. **Historical Context**: Yahoo Finance has a history of breaking changes:
   - July 2023: API URL changes broke multiple libraries
   - March 2025: Historical data retrieval issues
   - July 2025: Field availability issues

## Impact

- **Primary Provider**: Yahoo Finance is our primary (free, unlimited) data provider
- **Fallback**: Alpha Vantage is available but rate-limited (25 requests/day free tier)
- **Current Status**: Both providers failing → stock sync not working

## Solutions

### Short-term (Immediate)

1. **Wait for Library Update**: Monitor `piquette/finance-go` repository for fixes
   - GitHub: https://github.com/piquette/finance-go
   - Check for issues/PRs addressing Yahoo Finance API changes

2. **Use Alpha Vantage**: 
   - Upgrade to premium API key for higher rate limits
   - Implement better rate limiting/queuing
   - Cost: ~$50/month for basic plan

3. **Alternative Libraries**: Research alternative Go libraries:
   - `github.com/ranaroussi/yfinance` (Python, but could use via subprocess)
   - Direct HTTP calls to Yahoo Finance (risky, breaks easily)

### Medium-term (Recommended)

1. **Multiple Provider Strategy**: 
   - Add more providers (Polygon.io, IEX Cloud, etc.)
   - Implement provider health monitoring
   - Automatic failover between providers

2. **Caching Layer**:
   - Cache successful API responses
   - Reduce dependency on real-time API availability
   - Store historical data locally

3. **Error Handling Improvements**:
   - Better error messages with retry suggestions
   - Exponential backoff for transient errors
   - Provider health status tracking

### Long-term (Ideal)

1. **Official Data Sources**:
   - ASX official data feeds (paid)
   - Financial data aggregators (Bloomberg, Refinitiv)
   - More stable but expensive

2. **Self-hosted Data Collection**:
   - Web scraping with proper rate limiting
   - Direct database connections to data providers
   - More control but maintenance overhead

## Testing

Integration tests have been added in `providers/yahoo_test.go` to:
- Validate provider functionality
- Capture detailed error information
- Monitor when Yahoo Finance becomes available again

Run tests with:
```bash
cd services/market-data-sync
go test -v -tags=integration ./providers -run TestYahooFinanceProvider
```

## Monitoring

Check Yahoo Finance status:
1. **Library Issues**: https://github.com/piquette/finance-go/issues
2. **Yahoo Finance Status**: Monitor Yahoo Finance website directly
3. **Our Logs**: Check Cloud Run logs for error patterns

## Workaround

Until Yahoo Finance is fixed:
1. **Use Alpha Vantage**: Upgrade API key or wait for rate limit reset
2. **Manual Data Entry**: For critical stocks, manual entry via admin interface
3. **Historical Data**: Use existing data in database (no new updates)

## Related Files

- `providers/yahoo.go` - Yahoo Finance provider implementation
- `providers/yahoo_test.go` - Integration tests
- `providers/alpha_vantage.go` - Fallback provider
- `sync/sync.go` - Provider selection logic
