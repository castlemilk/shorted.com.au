# Market Data API - Connect RPC Protobuf Endpoints

The market data service is now successfully running with **Connect RPC and protobuf** on **http://localhost:8090**.

## ✅ Successfully Generated and Working

### Protobuf Code Generation
- Generated from: `proto/marketdata/v1/marketdata.proto`
- Generated to: `services/gen/proto/go/marketdata/v1/`
- Used: `protoc-gen-go` and `protoc-gen-connect-go`

### Connect RPC Service Endpoints

#### 1. Get Single Stock Price
```bash
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetStockPrice \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA"}'
```

**Response:**
```json
{
  "price": {
    "stockCode": "CBA",
    "date": "2025-08-08T00:00:00Z",
    "open": 98.11,
    "high": 101.54,
    "low": 97.42,
    "close": 100.7,
    "volume": "2894106",
    "adjustedClose": 100.7,
    "change": 2.59,
    "changePercent": 2.64
  }
}
```

#### 2. Get Historical Prices
```bash
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA", "period": "1w"}'
```

**Response:**
```json
{
  "prices": [
    {
      "stockCode": "CBA",
      "date": "2025-08-04T00:00:00Z",
      "open": 95.22,
      "high": 95.66,
      "low": 92.96,
      "close": 93.86,
      "volume": "615821",
      "adjustedClose": 93.86
    }
  ]
}
```

#### 3. Get Multiple Stock Prices
```bash
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetMultipleStockPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCodes": ["CBA", "BHP", "ANZ"]}'
```

**Response:**
```json
{
  "prices": {
    "ANZ": {
      "stockCode": "ANZ",
      "date": "2025-08-08T00:00:00Z",
      "open": 29.9,
      "close": 29.44,
      "change": -0.46,
      "changePercent": -1.54
    },
    "BHP": { ... },
    "CBA": { ... }
  }
}
```

#### 4. Get Stock Correlations
```bash
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetStockCorrelations \
  -H "Content-Type: application/json" \
  -d '{"stockCodes": ["CBA", "BHP"], "period": "1m"}'
```

## Key Features

### Protobuf Schema
- **Service**: `marketdata.v1.MarketDataService`
- **Message Types**: `StockPrice`, `GetHistoricalPricesRequest`, etc.
- **Timestamps**: Uses `google.protobuf.Timestamp` (converted from PostgreSQL DATE)
- **Validation**: Built-in request validation with proper error codes

### Connect RPC Features
- **HTTP/JSON Transport**: Standard HTTP POST with JSON payloads
- **Error Handling**: Connect RPC error codes (CodeNotFound, CodeInvalidArgument, etc.)
- **Type Safety**: Full protobuf type safety with generated Go structs
- **Auto-generated Clients**: Can generate TypeScript/JavaScript clients for frontend

### Data Processing
- **Timestamp Conversion**: PostgreSQL `DATE` → Go `time.Time` → `timestamppb.Timestamp`
- **Price Calculations**: Automatic change and change percentage calculations
- **Field Mapping**: JSON `stockCode` ↔ Proto `stock_code`

### Supported Periods
- `1d`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`

### Available Stocks
- CBA, BHP, CSL, WBC, ANZ, NAB, XRO, APT, WDS, TLS

## Technical Implementation

### Fixed Issues
1. **Missing Protobuf Generation**: Generated Go code from proto files
2. **Timestamp Scanning**: Fixed PostgreSQL DATE → protobuf Timestamp conversion
3. **Module Dependencies**: Used local generated modules instead of remote fetch
4. **Import Issues**: Added required `timestamppb` import

### Architecture
- **Transport**: Connect RPC over HTTP/1.1 with JSON
- **Database**: PostgreSQL via pgx driver  
- **Validation**: Request validation with Connect error codes
- **Logging**: Structured logging for debugging

## Comparison with Simple JSON API

| Feature | Connect RPC/Protobuf | Simple JSON |
|---------|---------------------|-------------|
| **Paths** | `/marketdata.v1.MarketDataService/GetStockPrice` | `/api/stocks/price` |
| **Type Safety** | ✅ Full protobuf types | ❌ Manual JSON structs |
| **Client Generation** | ✅ Auto-generated | ❌ Manual implementation |
| **Schema Evolution** | ✅ Protobuf compatibility | ❌ Manual versioning |
| **Validation** | ✅ Built-in + custom | ❌ Manual validation |
| **Error Handling** | ✅ Connect error codes | ❌ HTTP status codes |

**✅ The Connect RPC implementation is now the recommended approach** as it provides better type safety, automatic client generation, and follows the established patterns in the codebase.