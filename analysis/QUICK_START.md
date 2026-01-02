# Quick Start - Populate Shorts Data

**Goal**: Load short position data into your local database in under 5 minutes.

## Prerequisites

- PostgreSQL running (locally or remote)
- CSV files already downloaded in `data/shorts/` directory

## One-Command Setup

```bash
cd analysis
make install && make populate-skip-download
```

That's it! ☕ Grab a coffee while it processes ~3,500 CSV files.

> **Note**: Defaults to `postgresql://postgres:postgres@localhost:5432/postgres`  
> Override with: `export DATABASE_URL="postgresql://..."`

---

## Step-by-Step Guide

### 1. Check Your Environment

```bash
cd analysis
make status
```

Expected output:

```
📊 SHORT POSITION DATA STATUS
========================================

1️⃣  Python Dependencies:
   ✅ All dependencies installed  (or ❌ if not)

2️⃣  CSV Files:
   ✅ Found 3530 CSV files

3️⃣  Database:
   ⚠️  DATABASE_URL not set
```

### 2. Install Dependencies (if needed)

```bash
make install
```

This installs: httpx, tqdm, pandas, dask, chardet, sqlalchemy, psycopg2-binary

### 3. Set Database URL (Optional)

**Default**: `postgresql://postgres:postgres@localhost:5432/postgres`

Only set if using a different database:

```bash
# For custom local database
export DATABASE_URL="postgresql://myuser:mypass@localhost:5432/mydb"

# For Supabase
export DATABASE_URL="postgresql://postgres.xxx:xxx@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
```

### 4. Load Data

If you have CSV files:

```bash
make populate-skip-download
```

If you need to download them first:

```bash
make populate
```

### 5. Verify

```bash
make verify
```

Expected output:

```
✅ Verifying shorts data in database...

📊 Record counts:
 total_records
---------------
      18543287

📊 Unique stocks:
 unique_stocks
---------------
          2587

📅 Date range:
  earliest  |   latest
------------+------------
 2010-01-04 | 2025-10-31

📈 Top 10 stocks by record count:
 PRODUCT_CODE | records
--------------+---------
 CBA          |    3847
 BHP          |    3845
 ANZ          |    3842
 ...
```

---

## Troubleshooting

### "No CSV files found"

You need to download them first:

```bash
make download
```

This will ask for confirmation and download ~3,500 files (~1GB).

### "DATABASE_URL not set"

Make sure you export it:

```bash
export DATABASE_URL="postgresql://..."
```

### "Missing dependencies"

Run:

```bash
make install
```

### Want to test without writing to DB?

```bash
make dry-run
```

---

## All Available Commands

```bash
make help                  # Show all commands
make status               # Check environment
make install              # Install Python deps
make download             # Download CSV files
make populate             # Full pipeline
make populate-skip-download  # Use existing CSVs
make append               # Append to existing data
make dry-run              # Test without DB write
make verify               # Check database
make clean                # Remove CSV files
make sample               # Load sample data only
```

---

## What Happens During Population?

```
make populate-skip-download
    ↓
📊 Processing CSV files into DataFrame...
📁 Found 3530 CSV files
⚙️  Processing (this may take a few minutes)...
[########################################] | 100% Completed | 8.3 s
✅ Processed 18,543,287 records
    ↓
💾 Writing data to PostgreSQL...
   Table: shorts
   Mode: replace
   Records: 18,543,287
   Writing in 1855 chunks...
Writing to DB: 100%|████████████| 18543287/18543287 [02:15<00:00]
✅ Write complete
✅ Verified: 18,543,287 records in database
    ↓
✅ COMPLETE
```

**Total time**: 10-15 minutes

---

## Next Steps

After populating shorts data, you probably want stock price data too:

```bash
cd ../services/market-data
pip install -r requirements.txt
export DATABASE_URL="postgresql://..."
python3 populate_simple.py  # Major stocks (5-10 min)
# OR
python3 populate_from_shorts_data.py  # All stocks with shorts (20-30 min)
```

Then start your services:

```bash
cd services
make run.shorts      # Terminal 1
make run.market-data # Terminal 2

cd web
npm run dev          # Terminal 3
```

Visit `http://localhost:3020/shorts/CBA` and see both charts! 📈

---

## Complete Documentation

- [analysis/README.md](README.md) - Full analysis scripts documentation
- [DATA_POPULATION_SUMMARY.md](../DATA_POPULATION_SUMMARY.md) - Quick reference
- [LOCAL_SETUP.md](../LOCAL_SETUP.md) - Complete local dev setup
