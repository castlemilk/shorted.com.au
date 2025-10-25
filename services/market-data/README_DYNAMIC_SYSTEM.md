# Enhanced ASX Stock Data Processor

## Overview

This enhanced stock data processor supports **ALL ASX stocks dynamically** using Alpha Vantage API as the primary data source with Yahoo Finance as fallback. The system automatically discovers and processes any valid ASX stock symbol without requiring static lists.

## Key Features

### 🎯 Dynamic Stock Discovery

- **Supports ALL ASX stocks** from the comprehensive CSV file (2000+ stocks)
- **Automatic symbol validation** for any ASX stock code
- **Dynamic symbol resolution** for different API providers
- **Industry-based filtering** and market cap ranking

### 🔄 Dual API Support

- **Alpha Vantage priority** - Primary data source with API key `UOI9AM59F03A0WZC`
- **Yahoo Finance fallback** - Automatic fallback when Alpha Vantage fails
- **Intelligent error handling** with provider-specific retry logic
- **Rate limiting** to respect API limits

### 📊 Flexible Processing

- **Configurable limits** - Process top N stocks by market cap or all stocks
- **Batch processing** with progress tracking
- **Incremental updates** - Skip stocks with existing data
- **Comprehensive logging** with detailed progress reports

## Files Overview

### Core Components

1. **`asx_stock_resolver.py`** - Dynamic ASX stock discovery and symbol resolution
2. **`enhanced_historical_processor.py`** - Main historical data processor
3. **`enhanced_daily_sync.py`** - Daily sync processor
4. **`test_dynamic_system.py`** - Comprehensive test suite

### Data Providers

1. **`data_providers/alpha_vantage.py`** - Alpha Vantage API integration
2. **`data_providers/yahoo_finance.py`** - Yahoo Finance API integration
3. **`data_providers/factory.py`** - Provider factory pattern
4. **`data_providers/base.py`** - Abstract base classes

## Usage

### Historical Data Population

```python
from enhanced_historical_processor import EnhancedStockDataProcessor

# Initialize processor
processor = EnhancedStockDataProcessor()

# Process top 50 stocks by market cap
await processor.populate_all_stocks(years=10, limit=50)

# Process ALL ASX stocks (warning: very long runtime!)
await processor.populate_all_stocks(years=10, limit=None)
```

### Daily Sync

```python
from enhanced_daily_sync import EnhancedDailySync

# Initialize sync processor
sync_processor = EnhancedDailySync()

# Sync top 100 stocks
await sync_processor.run_daily_sync(days_back=5, limit=100)

# Sync ALL ASX stocks
await sync_processor.run_daily_sync(days_back=5, limit=None)
```

### Dynamic Stock Discovery

```python
from asx_stock_resolver import get_dynamic_processor

processor = get_dynamic_processor()

# Get all available stocks
all_stocks = processor.get_available_stocks()
print(f"Total ASX stocks: {len(all_stocks)}")

# Validate a symbol
is_valid = processor.validate_stock_symbol("CBA")
print(f"CBA is valid: {is_valid}")

# Get top stocks by market cap
top_stocks = processor.get_top_stocks(10)
print(f"Top 10 stocks: {top_stocks}")

# Search stocks
results = processor.search_stocks("Bank")
print(f"Banking stocks: {results}")
```

## API Key Configuration

The Alpha Vantage API key is configured as:

```
ALPHA_VANTAGE_API_KEY=UOI9AM59F03A0WZC
```

## Symbol Resolution

The system automatically resolves ASX symbols for different providers:

- **Alpha Vantage**: `CBA` (no suffix)
- **Yahoo Finance**: `CBA.AX` (with .AX suffix)

## Rate Limiting

- **Alpha Vantage**: 12 seconds between requests (5 requests/minute)
- **Yahoo Finance**: 2 seconds between requests (more lenient)

## Testing

Run the comprehensive test suite:

```bash
python test_dynamic_system.py
```

This tests:

- ASX stock discovery from CSV
- Symbol validation and resolution
- Enhanced processor functionality
- Alpha Vantage and Yahoo Finance integration
- Comprehensive system integration

## Performance Considerations

### Recommended Limits

- **Historical population**: Start with `limit=50` for top stocks
- **Daily sync**: Use `limit=100` for regular updates
- **Full processing**: Only use `limit=None` for complete data refresh

### Processing Time Estimates

- **Top 50 stocks**: ~20-30 minutes
- **Top 100 stocks**: ~40-60 minutes
- **All ASX stocks**: 4-6 hours (2000+ stocks)

## Error Handling

The system includes comprehensive error handling:

- **Invalid symbols**: Automatically validated and skipped
- **API failures**: Automatic fallback between providers
- **Rate limiting**: Automatic delays and retry logic
- **Data quality**: Validation and cleaning of fetched data

## Database Schema

The system uses the existing `stock_prices` table:

```sql
CREATE TABLE stock_prices (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2),
    adjusted_close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);
```

## Migration from Static Lists

The new system replaces all static stock lists with dynamic discovery:

- ✅ **Before**: Hardcoded lists of ~20-50 stocks
- ✅ **After**: Dynamic discovery of 2000+ ASX stocks
- ✅ **Before**: Manual symbol management
- ✅ **After**: Automatic symbol validation and resolution
- ✅ **Before**: Single API provider
- ✅ **After**: Dual API with intelligent fallback

## Future Enhancements

- **Real-time data**: Intraday price updates
- **Additional providers**: Integration with more data sources
- **Machine learning**: Data quality scoring and anomaly detection
- **Caching**: Redis-based caching for improved performance
- **Monitoring**: Health checks and alerting for API failures
