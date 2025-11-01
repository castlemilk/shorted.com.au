.PHONY: help install download populate populate-skip-download append dry-run clean verify

# Default database URL for local development
# Note: Local docker-compose uses admin/password on port 5438
DATABASE_URL ?= postgresql://admin:password@localhost:5438/shorts

# Default target
help:
	@echo "📊 Short Position Data Population"
	@echo ""
	@echo "Available commands:"
	@echo "  make install                 - Install Python dependencies"
	@echo "  make download                - Download CSV files from ASIC (10-20 min)"
	@echo "  make populate                - Download + process + load to DB (30-60 min)"
	@echo "  make populate-skip-download  - Process existing CSVs + load to DB (15-20 min)"
	@echo "  make append                  - Append new data to existing table"
	@echo "  make dry-run                 - Test processing without writing to DB"
	@echo "  make verify                  - Verify data in database"
	@echo "  make clean                   - Remove downloaded CSV files"
	@echo ""
	@echo "Database:"
	@echo "  Defaults to: postgresql://postgres:postgres@localhost:5432/postgres"
	@echo "  Override with: export DATABASE_URL='postgresql://...'"
	@echo ""
	@echo "Example usage:"
	@echo "  make install"
	@echo "  make populate-skip-download"
	@echo ""
	@echo "  # Or with custom database:"
	@echo "  export DATABASE_URL='postgresql://user:pass@host:5432/db'"
	@echo "  make populate-skip-download"

# Install Python dependencies
install:
	@echo "📦 Installing Python dependencies..."
	pip install -r requirements.txt
	@echo "✅ Dependencies installed"

# Download CSV files from ASIC
download:
	@echo "📥 Downloading short position data from ASIC..."
	@echo "⚠️  This will download ~3,500 CSV files (~1GB)"
	@echo "⏱️  Estimated time: 10-20 minutes"
	@echo ""
	@read -p "Continue? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		cd ../scripts && npm install && npx ts-node sync-short-data.ts; \
	else \
		echo "❌ Cancelled"; \
		exit 1; \
	fi

# Full population: download + process + load
populate:
	@echo "🚀 Full population: download + process + load"
	@echo "📊 Database: $(DATABASE_URL)"
	@echo "⏱️  Estimated time: 30-60 minutes"
	@echo ""
	DATABASE_URL=$(DATABASE_URL) python3 populate_shorts_from_csv.py

# Process existing CSVs and load to database
populate-skip-download:
	@echo "🚀 Processing existing CSV files and loading to database..."
	@echo "📊 Database: $(DATABASE_URL)"
	@echo "⏱️  Estimated time: 15-20 minutes"
	@echo ""
	DATABASE_URL=$(DATABASE_URL) python3 populate_shorts_from_csv.py --skip-download

# Append new data to existing table
append:
	@echo "➕ Appending new data to existing shorts table..."
	@echo "📊 Database: $(DATABASE_URL)"
	DATABASE_URL=$(DATABASE_URL) python3 populate_shorts_from_csv.py --skip-download --append

# Dry run - process but don't write to database
dry-run:
	@echo "🧪 Dry run - processing data without database write..."
	python3 populate_shorts_from_csv.py --skip-download --dry-run

# Verify data in database
verify:
	@echo "✅ Verifying shorts data in database..."
	@echo "📊 Database: $(DATABASE_URL)"
	@echo ""
	@echo "📊 Record counts:"
	@psql "$(DATABASE_URL)" -c "SELECT COUNT(*) as total_records FROM shorts;"
	@echo ""
	@echo "📊 Unique stocks:"
	@psql "$(DATABASE_URL)" -c "SELECT COUNT(DISTINCT \"PRODUCT_CODE\") as unique_stocks FROM shorts;"
	@echo ""
	@echo "📅 Date range:"
	@psql "$(DATABASE_URL)" -c "SELECT MIN(\"DATE\")::date as earliest, MAX(\"DATE\")::date as latest FROM shorts;"
	@echo ""
	@echo "📈 Top 10 stocks by record count:"
	@psql "$(DATABASE_URL)" -c "SELECT \"PRODUCT_CODE\", COUNT(*) as records FROM shorts GROUP BY \"PRODUCT_CODE\" ORDER BY records DESC LIMIT 10;"

# Clean downloaded CSV files
clean:
	@echo "🧹 Cleaning downloaded CSV files..."
	@if [ -d "data/shorts" ]; then \
		rm -rf data/shorts/*.csv; \
		echo "✅ Cleaned $(shell ls -1 data/shorts/*.csv 2>/dev/null | wc -l) CSV files"; \
	else \
		echo "✅ No CSV files to clean"; \
	fi

# Quick start with sample data (no download required)
sample:
	@echo "🚀 Loading sample data (CBA, BHP, RMD, RMX)..."
	@echo "📊 Database: $(DATABASE_URL)"
	@psql "$(DATABASE_URL)" -f sql/init-db.sql
	@echo "✅ Sample data loaded"

# Check if CSV files exist
check-csvs:
	@echo "📁 Checking for CSV files..."
	@if [ -d "data/shorts" ]; then \
		count=$$(ls -1 data/shorts/*.csv 2>/dev/null | wc -l | tr -d ' '); \
		if [ "$$count" -gt 0 ]; then \
			echo "✅ Found $$count CSV files in data/shorts/"; \
			size=$$(du -sh data/shorts 2>/dev/null | cut -f1); \
			echo "📦 Total size: $$size"; \
		else \
			echo "⚠️  No CSV files found in data/shorts/"; \
			echo "   Run 'make download' to fetch them"; \
		fi; \
	else \
		echo "⚠️  Directory data/shorts/ does not exist"; \
		echo "   Run 'make download' to create it and fetch CSV files"; \
	fi

# Show status of everything
status:
	@echo "📊 SHORT POSITION DATA STATUS"
	@echo "========================================"
	@echo ""
	@echo "1️⃣  Python Dependencies:"
	@if python3 -c "import httpx, tqdm, pandas, dask, chardet, sqlalchemy, psycopg2" 2>/dev/null; then \
		echo "   ✅ All dependencies installed"; \
	else \
		echo "   ❌ Missing dependencies (run 'make install')"; \
	fi
	@echo ""
	@echo "2️⃣  CSV Files:"
	@if [ -d "data/shorts" ]; then \
		count=$$(ls -1 data/shorts/*.csv 2>/dev/null | wc -l | tr -d ' '); \
		if [ "$$count" -gt 0 ]; then \
			echo "   ✅ Found $$count CSV files"; \
		else \
			echo "   ⚠️  No CSV files (run 'make download')"; \
		fi; \
	else \
		echo "   ⚠️  No CSV files (run 'make download')"; \
	fi
	@echo ""
	@echo "3️⃣  Database:"
	@echo "   📊 URL: $(DATABASE_URL)"
	@if psql "$(DATABASE_URL)" -c "SELECT 1 FROM shorts LIMIT 1" >/dev/null 2>&1; then \
		count=$$(psql "$(DATABASE_URL)" -tAc "SELECT COUNT(*) FROM shorts"); \
		echo "   ✅ Connected - $$count records in shorts table"; \
	else \
		echo "   ⚠️  Cannot query shorts table (may be empty or not connected)"; \
	fi
	@echo ""
	@echo "========================================"
	@echo "Run 'make help' for available commands"

