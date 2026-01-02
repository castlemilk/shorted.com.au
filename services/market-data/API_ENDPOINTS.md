# Market Data API - Working Endpoints

The local market data service is now successfully running on **http://localhost:8090** and connected to the remote Supabase database.

## API Endpoints

### Health Check
```bash
curl http://localhost:8090/health
```

### Historical Stock Prices
```bash
curl -X POST http://localhost:8090/api/stocks/historical \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA", "period": "1m"}'
```

**Supported periods:**
- `1d` - 1 day
- `1w` - 1 week  
- `1m` - 1 month
- `3m` - 3 months
- `6m` - 6 months
- `1y` - 1 year
- `2y` - 2 years

### Multiple Stock Prices (Latest)
```bash
curl -X POST http://localhost:8090/api/stocks/multiple \
  -H "Content-Type: application/json" \
  -d '{"stockCodes": ["CBA", "BHP", "ANZ"]}'
```

## Available Stock Symbols
- CBA (Commonwealth Bank)
- BHP (BHP Billiton) 
- CSL (CSL Limited)
- WBC (Westpac)
- ANZ (ANZ Bank)
- NAB (National Australia Bank)
- XRO (Xero Limited)
- APT (Block/Afterpay)
- WDS (Woodside Energy)
- TLS (Telstra)

## Database
- **Host:** aws-0-ap-southeast-2.pooler.supabase.com:5432
- **Database:** postgres (Supabase)
- **Records:** 210 stock price records (21 days × 10 stocks)
- **Date Range:** Last 30 calendar days (21 business days)

## Sample Response
```json
{
  "success": true,
  "data": [
    {
      "stock_code": "CBA",
      "date": "2025-08-08T00:00:00Z",
      "open": 98.11,
      "high": 101.54,
      "low": 97.42,
      "close": 100.7,
      "volume": 2894106,
      "adjusted_close": 100.7,
      "change": 2.59,
      "change_percent": 2.64
    }
  ]
}
```

## Service Status
✅ **CONFIRMED WORKING** - Local service successfully connects to remote Supabase database and returns historical stock data.