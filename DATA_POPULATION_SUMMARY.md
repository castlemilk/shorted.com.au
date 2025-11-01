# Data Population Summary

Quick reference for populating local database with both shorts and price data.

## TL;DR - Fastest Local Setup

```bash
# Start PostgreSQL
docker-compose -f analysis/sql/docker-compose.yaml up -d

# Load sample data (30 seconds)
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
psql $DATABASE_URL -f analysis/sql/init-db.sql

# Start services
cd services
make run.shorts      # Terminal 1
make run.market-data # Terminal 2

# Start frontend
cd web && npm install && npm run dev  # Terminal 3

# Visit http://localhost:3020
```

**Result**: Sample data for CBA, BHP, RMD, RMX (last 2 days)

---

## For Real Data (Choose Your Adventure)

### Option 1: Quick Dev Data (15 minutes) ⭐ RECOMMENDED

Real data for major stocks:

```bash
cd /Users/benebsworth/projects/shorted
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# 1. Populate stock prices for major stocks (~50 stocks)
cd services/market-data
pip install -r requirements.txt
python3 populate_simple.py

# 2. Load sample shorts data (or populate from CSV if available)
cd ../../analysis
pip install -r requirements.txt
python3 populate_shorts_from_csv.py --skip-download --dry-run  # Check if CSVs exist
# If CSVs don't exist, use sample data:
psql $DATABASE_URL -f sql/init-db.sql
```

**Result**:

- Stock prices: 50 major stocks, 10 years each
- Shorts: Sample data or full historical if CSVs available

### Option 2: Complete Historical Data (30-60 minutes)

Full dataset:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# 1. Download + process + load shorts data (all-in-one)
cd analysis
make install
make populate  # Downloads CSVs, processes, and loads to DB

# 2. Populate stock prices for all stocks with shorts
cd ../services/market-data
pip install -r requirements.txt
python3 populate_from_shorts_data.py
```

Or step-by-step:

```bash
# Download CSVs first
cd analysis
make download

# Then process and load
make populate-skip-download

# Finally, populate stock prices
cd ../services/market-data
python3 populate_from_shorts_data.py
```

**Result**:

- Stock prices: ~500 stocks, 10 years each
- Shorts: ~18M records, 10+ years, all ASX stocks

### Option 3: Production-Like Dataset (1-2 hours)

Complete ASX dataset:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Complete shorts data (same as Option 2)
cd scripts && npx ts-node sync-short-data.ts
cd ../analysis && python3 populate_shorts_from_csv.py --skip-download

# ALL 2,291 ASX stocks
cd ../services/market-data
make populate-all-stocks
```

**Result**:

- Stock prices: 2,291 stocks, 10 years each (~2.8M records)
- Shorts: ~18M records, 10+ years

---

## Makefile Quick Reference

The analysis directory now has a Makefile for easier data population:

```bash
cd analysis

# Check what you have
make status

# Install dependencies
make install

# Load existing CSVs to database (defaults to localhost:5432)
make populate-skip-download

# Download + process + load (all-in-one)
make populate

# Verify data loaded correctly
make verify

# Get help
make help
```

> **Default Database**: `postgresql://postgres:postgres@localhost:5432/postgres`  
> **Override**: `export DATABASE_URL="postgresql://..."`

---

## Scripts Reference

### Short Position Data

| Script                        | Location        | Purpose                          | Time      |
| ----------------------------- | --------------- | -------------------------------- | --------- |
| `init-db.sql`                 | `analysis/sql/` | Sample data (CBA, BHP, RMD, RMX) | 5 sec     |
| `sync-short-data.ts`          | `scripts/`      | Download CSVs from ASIC          | 10-20 min |
| `populate_shorts_from_csv.py` | `analysis/`     | Load CSVs → DB                   | 10-15 min |

### Stock Price Data

| Script                         | Location                | Purpose                | Time      |
| ------------------------------ | ----------------------- | ---------------------- | --------- |
| `populate_simple.py`           | `services/market-data/` | 50 major stocks        | 5-10 min  |
| `populate_from_shorts_data.py` | `services/market-data/` | All stocks with shorts | 20-30 min |
| `populate_all_asx_from_csv.py` | `services/market-data/` | All 2,291 ASX stocks   | 60-90 min |

---

## Verification Commands

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Quick counts
psql $DATABASE_URL -c "
SELECT
  (SELECT COUNT(*) FROM shorts) as short_records,
  (SELECT COUNT(DISTINCT \"PRODUCT_CODE\") FROM shorts) as unique_stocks_with_shorts,
  (SELECT COUNT(*) FROM stock_prices) as price_records,
  (SELECT COUNT(DISTINCT stock_code) FROM stock_prices) as unique_stocks_with_prices;
"

# Check specific stock (CBA)
psql $DATABASE_URL -c "
SELECT
  (SELECT COUNT(*) FROM shorts WHERE \"PRODUCT_CODE\" = 'CBA') as cba_short_records,
  (SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'CBA') as cba_price_records;
"

# Date ranges
psql $DATABASE_URL -c "
SELECT 'shorts' as table_name, MIN(\"DATE\")::date as earliest, MAX(\"DATE\")::date as latest FROM shorts
UNION ALL
SELECT 'stock_prices', MIN(date)::date, MAX(date)::date FROM stock_prices;
"
```

Expected results by option:

| Metric             | Sample | Option 1 | Option 2 | Option 3 |
| ------------------ | ------ | -------- | -------- | -------- |
| Short records      | 14     | 14       | ~18M     | ~18M     |
| Stocks with shorts | 4      | 4        | ~2,587   | ~2,587   |
| Price records      | 0      | ~125K    | ~1.2M    | ~2.8M    |
| Stocks with prices | 0      | 50       | ~500     | 2,291    |

---

## Common Issues

### "No CSV files found"

The shorts CSV files need to be downloaded first:

```bash
cd scripts
npx ts-node sync-short-data.ts
```

### "No module named 'httpx'" or similar

Install Python dependencies:

```bash
cd analysis
pip install -r requirements.txt

cd services/market-data
pip install -r requirements.txt
```

### "No data available" in charts

Either:

1. Tables are empty → Run population scripts
2. Services can't connect → Check `DATABASE_URL`
3. Frontend can't reach APIs → Check services are running on ports 9091 and 8090

### Slow population

This is normal! Yahoo Finance API is rate-limited:

- ~0.5 seconds per stock
- 2,291 stocks = ~20 minutes minimum

Don't interrupt it - just let it run.

---

## What Each Service Needs

| Service                         | Requires Table(s) | Population Script               |
| ------------------------------- | ----------------- | ------------------------------- |
| Shorts Service (port 9091)      | `shorts`          | `populate_shorts_from_csv.py`   |
| Market Data Service (port 8090) | `stock_prices`    | `populate_simple.py` or similar |
| Frontend                        | Both (via APIs)   | Both scripts                    |

---

## Files Created

```
analysis/
├── populate_shorts_from_csv.py  ← NEW: Standalone script (was Jupyter notebook)
├── requirements.txt              ← NEW: Python dependencies
├── README.md                     ← NEW: Detailed docs
├── process-data.ipynb            ← OLD: Original notebook (still works)
└── sql/
    └── init-db.sql               ← Sample data loader

services/market-data/
├── populate_simple.py            ← Major stocks (recommended)
├── populate_from_shorts_data.py  ← All stocks with shorts
├── populate_all_asx_from_csv.py  ← Complete ASX dataset
└── requirements.txt              ← Python dependencies

scripts/
└── sync-short-data.ts            ← Download CSVs from ASIC

/
├── LOCAL_SETUP.md                ← NEW: Complete local dev guide
└── DATA_POPULATION_SUMMARY.md    ← NEW: This file
```

---

## Recommended Workflow

**For frontend development**:

```bash
Option 1 (Quick Dev Data) - you get real charts quickly
```

**For backend development**:

```bash
Sample data (init-db.sql) - faster iteration
```

**For integration testing**:

```bash
Option 2 (Complete Historical) - realistic data volumes
```

**For performance testing**:

```bash
Option 3 (Production-Like) - full dataset
```

---

## Next Steps

After populating data:

1. ✅ Start services: See [LOCAL_SETUP.md](LOCAL_SETUP.md)
2. ✅ Test charts: Visit `http://localhost:3020/shorts/CBA`
3. ✅ Set up daily sync: See `services/market-data/Makefile` (deploy-daily-sync)

---

For complete setup instructions, see [LOCAL_SETUP.md](LOCAL_SETUP.md)
