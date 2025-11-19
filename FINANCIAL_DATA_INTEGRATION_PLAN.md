# Financial Data Integration Plan

## 🎯 Goal
Enrich company profiles with quantitative financial data from Yahoo Finance and Google Finance to complement the GPT-generated qualitative data.

## 📊 Data We Can Reliably Extract

### From Google Finance ✅ (Works Well)
- ✅ Current stock price
- ✅ Price change & change %
- ✅ Company description
- ✅ CEO name
- ✅ Founded date
- ✅ Headquarters location
- ✅ Employee count

### From Yahoo Finance ⚠️ (Needs Work - Dynamic Content)
- ⏳ Market cap
- ⏳ Volume
- ⏳ P/E ratio
- ⏳ EPS
- ⏳ Dividend yield
- ⏳ 52-week high/low
- ⏳ Beta

**Note**: Yahoo Finance uses dynamic JavaScript rendering, so direct scraping is limited. Alternative: Use `yfinance` Python library.

## 🔄 Integration Strategy

### Option A: Lightweight (Recommended)
**Use Google Finance for metadata only**

```python
# In enrichment pipeline, add after GPT enrichment:
google_data = fetch_google_finance_comprehensive(stock_code)

# Merge into enriched_data
if google_data['profile'].get('description') and not enriched_data.get('enhanced_summary'):
    enriched_data['enhanced_summary'] = google_data['profile']['description']

if google_data['profile'].get('employees'):
    enriched_data['employee_count'] = google_data['profile']['employees']
```

**Benefits**:
- Fast and reliable
- Fills gaps when GPT doesn't find data
- No additional dependencies

### Option B: Comprehensive (Best Quality)
**Use `yfinance` library for Yahoo Finance data**

```bash
pip install yfinance
```

```python
import yfinance as yf

def fetch_yahoo_with_library(stock_code: str) -> Dict:
    ticker = yf.Ticker(f"{stock_code}.AX")
    
    # Get all data
    info = ticker.info
    
    return {
        'market_cap': info.get('marketCap'),
        'current_price': info.get('currentPrice'),
        'pe_ratio': info.get('trailingPE'),
        'forward_pe': info.get('forwardPE'),
        'eps': info.get('trailingEps'),
        'dividend_yield': info.get('dividendYield'),
        'beta': info.get('beta'),
        'week_52_high': info.get('fiftyTwoWeekHigh'),
        'week_52_low': info.get('fiftyTwoWeekLow'),
        'volume': info.get('volume'),
        'description': info.get('longBusinessSummary'),
        'sector': info.get('sector'),
        'industry': info.get('industry'),
        'employees': info.get('fullTimeEmployees'),
        'website': info.get('website'),
    }
```

## 📂 Database Schema Extension

### Option 1: Store in existing fields (No migration)
```sql
-- Use existing columns:
enhanced_summary  -- Company description from Google/Yahoo
-- Add to company_history field:
-- "Market Cap: $X billion | P/E: X | Employees: X"
```

### Option 2: Add financial metrics table (Better)
```sql
-- New migration: 003_add_financial_metrics.sql
CREATE TABLE company_financial_metrics (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL REFERENCES "company-metadata"(stock_code),
    
    -- Market Data
    current_price DECIMAL(12, 2),
    market_cap BIGINT,
    volume BIGINT,
    
    -- Valuation Metrics
    pe_ratio DECIMAL(8, 2),
    forward_pe DECIMAL(8, 2),
    eps DECIMAL(8, 2),
    dividend_yield DECIMAL(5, 2),
    beta DECIMAL(5, 2),
    
    -- 52-week range
    week_52_high DECIMAL(12, 2),
    week_52_low DECIMAL(12, 2),
    
    -- Company info
    employee_count INTEGER,
    sector VARCHAR(100),
    industry VARCHAR(100),
    
    -- Metadata
    data_source VARCHAR(50),  -- 'yahoo_finance' or 'google_finance'
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(stock_code, last_updated)
);

CREATE INDEX idx_financial_metrics_stock_code ON company_financial_metrics(stock_code);
CREATE INDEX idx_financial_metrics_updated ON company_financial_metrics(last_updated DESC);
```

### Option 3: Store as JSONB (Flexible)
```sql
-- Add to existing company-metadata table:
ALTER TABLE "company-metadata"
ADD COLUMN financial_metrics JSONB DEFAULT '{}'::jsonb,
ADD COLUMN financial_metrics_updated_at TIMESTAMP WITH TIME ZONE;

-- Example data:
{
  "market_data": {
    "current_price": 48.25,
    "market_cap": 123456789,
    "volume": 1234567
  },
  "key_statistics": {
    "pe_ratio": 15.5,
    "eps": 3.21,
    "dividend_yield": 4.5
  },
  "sources": ["google_finance", "yahoo_finance"],
  "last_updated": "2025-01-15T10:30:00Z"
}
```

## 🔧 Implementation Steps

### Step 1: Install yfinance (1 minute)
```bash
cd analysis
source ../venv/bin/activate
pip install yfinance
echo "yfinance>=0.2.0" >> requirements.txt
```

### Step 2: Add financial data fetcher to notebook (5 minutes)

Create new Cell 6.5 in notebook:

```python
# Cell 6.5: Financial Data Enrichment

import yfinance as yf

def fetch_financial_metrics(stock_code: str) -> Dict[str, Any]:
    """
    Fetch financial metrics from Yahoo Finance using yfinance library.
    """
    try:
        ticker = yf.Ticker(f"{stock_code}.AX")
        info = ticker.info
        
        return {
            'market_cap': info.get('marketCap'),
            'current_price': info.get('currentPrice'),
            'pe_ratio': info.get('trailingPE'),
            'eps': info.get('trailingEps'),
            'dividend_yield': info.get('dividendYield', 0) * 100,  # Convert to percentage
            'beta': info.get('beta'),
            'week_52_high': info.get('fiftyTwoWeekHigh'),
            'week_52_low': info.get('fiftyTwoWeekLow'),
            'volume': info.get('volume'),
            'employee_count': info.get('fullTimeEmployees'),
            'sector': info.get('sector'),
            'industry': info.get('industry'),
            'description': info.get('longBusinessSummary'),
            'website': info.get('website'),
            'data_source': 'yahoo_finance',
            'last_updated': datetime.now().isoformat()
        }
    except Exception as e:
        print(f"  ⚠️  Could not fetch financial data for {stock_code}: {e}")
        return {}

print("✓ Financial metrics fetcher defined")
```

### Step 3: Integrate into enrichment workflow (Cell 8)

```python
# In process_batch_with_checkpoints function, after GPT enrichment:

# Fetch financial metrics
print(f"  💰 Fetching financial metrics...")
financial_metrics = fetch_financial_metrics(stock_code)

# Merge into enriched_data
if financial_metrics:
    enriched_data['financial_metrics'] = financial_metrics
    
    # Use as fallback for missing data
    if not enriched_data.get('enhanced_summary') and financial_metrics.get('description'):
        enriched_data['enhanced_summary'] = financial_metrics['description']
    
    if financial_metrics.get('employee_count'):
        # Add to company_history or key_people context
        enriched_data['company_history'] = enriched_data.get('company_history', '') + \
            f"\n\nEmployee Count: {financial_metrics['employee_count']:,}"
```

### Step 4: Update database schema (Choose option)

**Quick (Option 3 - JSONB):**
```bash
psql $DATABASE_URL -c "ALTER TABLE \"company-metadata\" ADD COLUMN IF NOT EXISTS financial_metrics JSONB DEFAULT '{}'::jsonb;"
```

**Better (Option 2 - Dedicated table):**
```bash
psql $DATABASE_URL -f supabase/migrations/003_add_financial_metrics.sql
```

### Step 5: Update Cell 10 to save financial data

```python
# In update_database function:
if 'financial_metrics' in result:
    # Option 3 (JSONB):
    query = text("""
        UPDATE "company-metadata"
        SET 
            ...existing fields...,
            financial_metrics = :financial_metrics,
            financial_metrics_updated_at = CURRENT_TIMESTAMP
        WHERE stock_code = :stock_code
    """)
    
    update_data['financial_metrics'] = json.dumps(result['financial_metrics'])
```

## 📈 Expected Results

### Before (GPT only):
```json
{
  "stock_code": "BHP",
  "enhanced_summary": "BHP Group is a mining company...",
  "tags": ["mining", "resources", "iron ore"]
}
```

### After (GPT + Financial Data):
```json
{
  "stock_code": "BHP",
  "enhanced_summary": "BHP Group is a mining company...",
  "tags": ["mining", "resources", "iron ore"],
  "financial_metrics": {
    "market_cap": 158000000000,
    "current_price": 42.50,
    "pe_ratio": 12.5,
    "dividend_yield": 5.8,
    "employee_count": 80000,
    "sector": "Basic Materials",
    "data_source": "yahoo_finance",
    "last_updated": "2025-01-15T10:00:00Z"
  }
}
```

## 💰 Cost & Performance

| Source | Speed | Cost | Data Quality |
|--------|-------|------|--------------|
| Google Finance (scrape) | Fast (1-2s) | FREE | Good (basic) |
| Yahoo Finance (yfinance) | Medium (2-3s) | FREE | Excellent (comprehensive) |
| GPT enrichment | Slow (10-20s) | ~$0.02 | Excellent (qualitative) |

**Total per company**: 3-5s additional + FREE (no API costs!)

## 🎯 Recommendation

**Phase 1** (Quick Win - Today):
1. Use `yfinance` library (simple, reliable)
2. Store as JSONB in existing table (no migration)
3. Use as fallback when GPT data is missing

**Phase 2** (Production - Later):
1. Create dedicated financial_metrics table
2. Schedule daily updates (prices change)
3. Add historical tracking

## 🚀 Quick Start

```bash
# 1. Install yfinance
pip install yfinance

# 2. Test it works
python -c "import yfinance as yf; print(yf.Ticker('BHP.AX').info.get('marketCap'))"

# 3. Add Cell 6.5 to notebook (financial data fetcher)
# 4. Add to Cell 8 (integrate into workflow)
# 5. Update Cell 10 (save to database)
# 6. Run enrichment on 5-10 companies to test
# 7. Scale to production
```

Ready to implement? 🎯
