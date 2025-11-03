# Pluggable Data Providers with Automatic Fallback

## Summary

Implemented a sophisticated pluggable provider system for stock price data ingestion with automatic fallback between multiple data sources.

## Architecture

### Provider System

```
┌─────────────────────────────────────────┐
│   Stock Price Ingestion Service        │
│                                         │
│   ┌───────────────────────────────┐   │
│   │  Data Provider Factory        │   │
│   └───────────────────────────────┘   │
│              │                          │
│              ├─────────────────┐       │
│              ▼                 ▼       │
│   ┌──────────────────┐  ┌──────────┐  │
│   │ Alpha Vantage    │  │  Yahoo   │  │
│   │ Provider         │  │ Finance  │  │
│   │ (Primary)        │  │ Provider │  │
│   └──────────────────┘  │(Fallback)│  │
│              │           └──────────┘  │
│              │                 │        │
└──────────────┼─────────────────┼────────┘
               │                 │
               ▼                 ▼
      Alpha Vantage API    Yahoo Finance API
```

### Fallback Logic

1. **Try Primary Provider** (Alpha Vantage)

   - Lower rate limits but more reliable
   - Better data quality
   - Requires API key

2. **Automatic Fallback** (Yahoo Finance)
   - If primary fails
   - If rate limit exceeded
   - If symbol not found
   - No API key required

## Features

### ✅ Pluggable Architecture

- Factory pattern for easy provider management
- Base interface for all providers
- Easy to add new providers in the future

### ✅ Automatic Fallback

- Seamless switching between providers
- No manual intervention required
- Comprehensive error handling

### ✅ Error Handling

- **RateLimitError**: Automatically falls back when rate limited
- **SymbolNotFoundError**: Tries alternative provider if symbol not found
- **DataProviderError**: Generic provider errors trigger fallback
- **Circuit Breaker**: Protects against cascading failures

### ✅ Data Source Options

#### Alpha Vantage (Primary)

- Source: [Alpha Vantage API](https://www.alphavantage.co/)
- Rate Limit: 5 requests/minute, 500/day (free tier)
- Coverage: Global markets including ASX
- Data Quality: High (exchange-licensed provider)
- Requires: `ALPHA_VANTAGE_API_KEY` environment variable

#### Yahoo Finance (Fallback)

- Source: Yahoo Finance via yfinance library
- Rate Limit: More permissive
- Coverage: Broad market coverage
- Data Quality: Good
- Requires: No API key

## Files Changed

### New Files Created

- `services/stock-price-ingestion/data_providers/__init__.py` - Package initialization
- `services/stock-price-ingestion/data_providers/base.py` - Base provider interface
- `services/stock-price-ingestion/data_providers/factory.py` - Provider factory
- `services/stock-price-ingestion/data_providers/alpha_vantage.py` - Alpha Vantage provider
- `services/stock-price-ingestion/data_providers/yahoo_finance.py` - Yahoo Finance provider

### Modified Files

- `services/stock-price-ingestion/main.py` - Updated to use pluggable providers with fallback
- `web/src/@/lib/stock-data-service.ts` - Improved error handling (previous fix)
- `web/src/@/components/ui/sidebar.tsx` - UI improvements (previous fix)

## Configuration

### Environment Variables

```bash
# Primary Provider (Alpha Vantage)
# Get your free key from: https://www.alphavantage.co/support/#api-key
ALPHA_VANTAGE_API_KEY=your_api_key_here  # Required for Alpha Vantage

# Database
DATABASE_URL=postgresql://user:pass@host:5432/database

# Optional: Override provider selection
PRIMARY_PROVIDER=alpha_vantage  # default
FALLBACK_PROVIDER=yahoo_finance  # default
```

### Alpha Vantage API Key

**Default Key Configured:** `UOI9AM59F03A0WZC`

The service comes with a default Alpha Vantage API key pre-configured, so you can start using it immediately without any additional setup!

**To use your own key:**

1. Visit [Alpha Vantage](https://www.alphavantage.co/support/#api-key)
2. Enter your email and organization (free tier available)
3. Get your API key instantly
4. Set `ALPHA_VANTAGE_API_KEY` environment variable to override the default

## Usage

### For Local Development

```bash
# 1. Get your free Alpha Vantage API key from https://www.alphavantage.co/support/#api-key

# 2. Configure your API key
cd services/stock-price-ingestion
cp env.example .env
# Edit .env and set ALPHA_VANTAGE_API_KEY=your_key_here

# 3. Start database
cd ../..
make dev-db

# 4. Run backfill with new provider system (uses Alpha Vantage → Yahoo Finance fallback)
cd services
make history.stock-data.backfill
```

### For Production (Cloud Run)

Update the service configuration:

```bash
# services/stock-price-ingestion/service.yaml
env:
- name: ALPHA_VANTAGE_API_KEY
  valueFrom:
    secretKeyRef:
      name: ALPHA_VANTAGE_API_KEY
      key: latest
```

Deploy:

```bash
cd services/stock-price-ingestion
make deploy
```

## Provider Selection Strategy

The service automatically selects providers based on:

1. **Configuration**: Primary and fallback providers are configurable
2. **Availability**: If API key is not set, that provider is skipped
3. **Failures**: Automatic fallback on any provider failure
4. **Rate Limits**: Falls back when rate limits are exceeded

### Example Scenarios

**Scenario 1: Both providers available**

```
Request → Alpha Vantage (success) → Return data ✅
```

**Scenario 2: Alpha Vantage rate limited**

```
Request → Alpha Vantage (rate limit) → Yahoo Finance (success) → Return data ✅
```

**Scenario 3: Symbol not found in Alpha Vantage**

```
Request → Alpha Vantage (not found) → Yahoo Finance (success) → Return data ✅
```

**Scenario 4: Both providers fail**

```
Request → Alpha Vantage (fail) → Yahoo Finance (fail) → Return empty, log errors ❌
```

## Testing

### Test with specific provider

```python
from main import StockDataIngestion
from datetime import date, timedelta

# Test with Alpha Vantage only
ingestion = StockDataIngestion(
    db_url="your_db_url",
    primary_provider="alpha_vantage",
    fallback_provider="none"
)

# Test with Yahoo Finance only
ingestion = StockDataIngestion(
    db_url="your_db_url",
    primary_provider="yahoo_finance",
    fallback_provider="none"
)

# Test with automatic fallback (default)
ingestion = StockDataIngestion(db_url="your_db_url")
```

### Run integration tests

```bash
cd services/stock-price-ingestion
python -m pytest tests/ -v
```

## Monitoring

### Log Messages

The system logs detailed information about provider usage:

```
✅ Primary provider initialized: Alpha Vantage
✅ Fallback provider initialized: Yahoo Finance
🔄 Trying primary provider (Alpha Vantage) for CBA...
✅ Primary provider success for CBA: 2500 records
```

Or when falling back:

```
⚠️ Primary provider rate limit exceeded for BOE: Rate limit reached
🔄 Falling back to Yahoo Finance for BOE...
✅ Fallback provider success for BOE: 2500 records
```

### Check Provider Usage

Query the ingestion log to see which provider was used:

```sql
SELECT
  data_source,
  COUNT(*) as batch_count,
  AVG(records_inserted) as avg_records,
  MAX(completed_at) as last_run
FROM stock_data_ingestion_log
GROUP BY data_source
ORDER BY last_run DESC;
```

## Future Enhancements

### Potential Additional Providers

- **EOD Historical Data**: High-quality historical data
- **IEX Cloud**: Real-time and historical US market data
- **Polygon.io**: Real-time and historical market data
- **Finnhub**: Real-time stock, forex, and crypto data

### Enhancement Ideas

- **Provider health monitoring**: Track success rates per provider
- **Intelligent provider selection**: Choose based on historical reliability
- **Parallel fetching**: Try multiple providers simultaneously
- **Caching layer**: Reduce API calls for recently fetched data
- **Provider-specific optimizations**: Use batch endpoints where available

## Benefits

1. **Reliability**: Automatic fallback ensures data availability
2. **Cost Optimization**: Use free tier of Alpha Vantage, fallback to Yahoo when needed
3. **Flexibility**: Easy to add new providers or change priorities
4. **Maintainability**: Clean separation of concerns
5. **Testing**: Easy to mock and test individual providers
6. **Compliance**: Can switch providers based on licensing requirements

## References

- [Alpha Vantage Documentation](https://www.alphavantage.co/documentation/)
- [Alpha Vantage MCP Integration](https://www.alphavantage.co/documentation/#mcp)
- [Yahoo Finance yfinance Library](https://github.com/ranaroussi/yfinance)
- [Provider Pattern](https://en.wikipedia.org/wiki/Provider_model)
