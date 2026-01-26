# Analysis Scripts

Scripts for populating and analyzing short position data.

## Quick Start - Populate Shorts Data Locally

### Option 1: From Existing CSV Files (Fastest)

If CSV files are already downloaded in `data/shorts/`:

```bash
cd analysis

# Check status
make status

# Install dependencies
make install

# Load into local database (defaults to localhost:5432)
make populate-skip-download
```

> **Note**: Automatically uses `postgresql://postgres:postgres@localhost:5432/postgres`  
> Override with: `export DATABASE_URL="postgresql://your-database-url"`

Or using Python directly:

```bash
pip install -r requirements.txt
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
python3 populate_shorts_from_csv.py --skip-download
```

### Option 2: Download Fresh Data from ASIC

Download all historical short position data from ASIC (10+ years):

```bash
cd analysis

# Install dependencies
make install

# Download + process + load (one command, ~30-60 min)
make populate  # Uses localhost:5432 by default
```

Or step-by-step:

```bash
# Download CSV files
make download

# Then process and load
make populate-skip-download  # Uses localhost:5432 by default
```

> **Note**: Uses `postgresql://postgres:postgres@localhost:5432/postgres` by default

## Makefile Commands

**Default Database**: `postgresql://postgres:postgres@localhost:5432/postgres`

```bash
# Show available commands
make help

# Check environment status
make status

# Install Python dependencies
make install

# Download CSV files from ASIC (interactive)
make download

# Full pipeline: download + process + load (uses localhost:5432)
make populate

# Process existing CSVs and load to DB (uses localhost:5432)
make populate-skip-download

# Append new data to existing table
make append

# Test processing without database write
make dry-run

# Verify data in database
make verify

# Clean downloaded CSV files
make clean

# Load sample data (quick start)
make sample
```

**For custom database**, export `DATABASE_URL` before running:

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/db"
make populate-skip-download
```

## Script Options

If you prefer to use the Python script directly:

```bash
# Basic usage
python3 populate_shorts_from_csv.py

# Use existing CSV files (skip download)
python3 populate_shorts_from_csv.py --skip-download

# Append to existing table instead of replacing
python3 populate_shorts_from_csv.py --append

# Dry run (process but don't write to database)
python3 populate_shorts_from_csv.py --dry-run

# Specify database URL directly
python3 populate_shorts_from_csv.py --database-url "postgresql://user:pass@host:5432/db"

# Download and populate in one command
python3 populate_shorts_from_csv.py
```

## What It Does

The script:

1. **Downloads** (optional): Fetches ~3,500 CSV files from ASIC
2. **Processes**: Reads all CSVs with Dask for parallel processing
   - Handles different encodings (UTF-8, ISO-8859-1, etc.)
   - Normalizes column names and schema
   - Filters invalid records
3. **Loads**: Writes to PostgreSQL `shorts` table in batches
4. **Verifies**: Checks record count and prints summary

Expected output:

- **Records**: ~15-20 million records (10+ years of daily data)
- **Stocks**: ~2,500+ unique stock codes
- **Time**: 10-20 minutes (depending on CSV availability)

## Example Output

```
🚀 POPULATE SHORTS TABLE FROM CSV DATA
============================================================
Started: 2025-11-01 10:30:00
Database: localhost:5432/postgres
============================================================
📁 Created directory: data/shorts
⏭️  Skipping download (--skip-download flag set)

📊 Processing CSV files into DataFrame...
📁 Found 3495 CSV files
⚙️  Processing (this may take a few minutes)...
[########################################] | 100% Completed | 8.3 s
✅ Processed 18,543,287 records

============================================================
📊 DATA SUMMARY
============================================================
Total records: 18,543,287
Unique stocks: 2,587
Date range: 2010-01-04 to 2025-10-31
Memory usage: 1,234.5 MB

📈 Top 10 stocks by record count:
   CBA: 3,847 records
   BHP: 3,845 records
   ANZ: 3,842 records
   WBC: 3,840 records
   NAB: 3,838 records
   ...
============================================================

💾 Writing data to PostgreSQL...
   Table: shorts
   Mode: replace
   Records: 18,543,287
   Writing in 1855 chunks...
Writing to DB: 100%|████████████| 18543287/18543287 [02:15<00:00]
✅ Write complete
✅ Verified: 18,543,287 records in database

============================================================
✅ COMPLETE
Finished: 2025-11-01 10:42:15
============================================================
```

## Verify Data

After population, check your data:

```bash
# Quick count
psql $DATABASE_URL -c 'SELECT COUNT(*) FROM shorts;'

# By stock
psql $DATABASE_URL -c '
SELECT "PRODUCT_CODE", COUNT(*) as records,
       MIN("DATE") as earliest, MAX("DATE") as latest
FROM shorts
GROUP BY "PRODUCT_CODE"
ORDER BY records DESC
LIMIT 10;
'

# Check specific stock
psql $DATABASE_URL -c '
SELECT * FROM shorts
WHERE "PRODUCT_CODE" = '\''CBA'\''
ORDER BY "DATE" DESC
LIMIT 10;
'
```

## Troubleshooting

### "No CSV files found"

```bash
# Download them first
cd scripts
npx ts-node sync-short-data.ts
```

### "DATABASE_URL not set"

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
```

### "Missing required package"

```bash
pip install -r requirements.txt
```

### Memory issues

If processing fails due to memory:

```python
# Edit populate_shorts_from_csv.py
# Reduce chunk_size from 10000 to 5000
chunk_size = 5000
```

## Files

- `populate_shorts_from_csv.py` - Main script (converted from Jupyter notebook)
- `process-data.ipynb` - Original Jupyter notebook (deprecated)
- `requirements.txt` - Python dependencies
- `data/shorts/` - Directory for CSV files (~3,500 files, ~1GB)

## Next Steps

After populating shorts data, you probably also want stock price data:

```bash
cd ../services/market-data
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Install dependencies
pip install -r requirements.txt

# Populate price data for all stocks with shorts
python3 populate_from_shorts_data.py
```

Now both charts will work! 📈
