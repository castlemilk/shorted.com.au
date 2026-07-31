.PHONY: help install download populate populate-skip-download append dry-run clean verify enrich enrich-logos enrich-full

# Default database URL for local development
# Note: Local docker-compose uses admin/password on port 5438
DATABASE_URL ?= postgresql://admin:password@localhost:5438/shorts

# Default target
help:
	@echo "📊 Short Position Data Population & Enrichment"
	@echo ""
	@echo "Available commands:"
	@echo ""
	@echo "📥 DATA POPULATION:"
	@echo "  make install                 - Install Python dependencies"
	@echo "  make download                - Download CSV files from ASIC (10-20 min)"
	@echo "  make populate                - Download + process + load to DB (30-60 min)"
	@echo "  make populate-skip-download  - Process existing CSVs + load to DB (15-20 min)"
	@echo "  make append                  - Append new data to existing table"
	@echo "  make dry-run                 - Test processing without writing to DB"
	@echo "  make verify                  - Verify data in database"
	@echo "  make clean                   - Remove downloaded CSV files"
	@echo ""
	@echo "🎨 BATCH ENRICHMENT:"
	@echo "  make enrich                  - Run batch enrichment (metadata + logos)"
	@echo "  make enrich-subset N=10      - Run enrichment on N companies (default: 10)"
	@echo "  make enrich-full             - Run enrichment on ALL companies"
	@echo "  make notebook                - Start Jupyter notebook server"
	@echo ""
	@echo "Database:"
	@echo "  Defaults to: postgresql://admin:password@localhost:5438/shorts"
	@echo "  Override with: export DATABASE_URL='postgresql://...'"
	@echo ""
	@echo "📓 REGISTER OF INTERESTS NOTEBOOK:"
	@echo "  make register-notebook       - Preflight, then open the quality notebook"
	@echo "  make register-notebook-check - Preflight only (db, deps, corpus, format)"
	@echo "  make register-notebook-fix   - Repair a notebook Lab refuses to save (500)"
	@echo "  make register-notebook-smoke - Execute headlessly; fail on any cell error"
	@echo ""
	@echo "Example usage:"
	@echo "  make install"
	@echo "  make populate-skip-download"
	@echo "  make enrich-subset N=5       # Test on 5 companies"
	@echo ""
	@echo "  # Or with custom database:"
	@echo "  export DATABASE_URL='postgresql://user:pass@host:5432/db'"
	@echo "  make enrich"

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

# ============================================
# BATCH ENRICHMENT TARGETS
# ============================================

# Default subset size
N ?= 10

# Run batch enrichment notebook (subset mode for testing)
enrich:
	@echo "🎨 Running batch enrichment (subset mode: $(N) companies)..."
	@echo "📊 Database: $(DATABASE_URL)"
	@echo ""
	DATABASE_URL=$(DATABASE_URL) PROCESS_SUBSET=True SUBSET_SIZE=$(N) jupyter nbconvert --to notebook --execute batch-enrichment.ipynb --output batch-enrichment-output.ipynb
	@echo "✅ Enrichment complete - check batch-enrichment-output.ipynb for results"

# Run enrichment on N companies (alias for enrich)
enrich-subset:
	@echo "🎨 Running batch enrichment on $(N) companies..."
	@echo "📊 Database: $(DATABASE_URL)"
	DATABASE_URL=$(DATABASE_URL) PROCESS_SUBSET=True SUBSET_SIZE=$(N) jupyter nbconvert --to notebook --execute batch-enrichment.ipynb --output batch-enrichment-output.ipynb
	@echo "✅ Enrichment complete"

# Run enrichment on ALL companies (caution: can take hours and cost $$$)
enrich-full:
	@echo "🚨 FULL ENRICHMENT MODE"
	@echo "📊 Database: $(DATABASE_URL)"
	@echo "⚠️  This will process ALL companies in the database!"
	@echo "⚠️  This can take several hours and may incur significant API costs."
	@echo ""
	@read -p "Are you sure you want to continue? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		DATABASE_URL=$(DATABASE_URL) PROCESS_SUBSET=False jupyter nbconvert --to notebook --execute batch-enrichment.ipynb --output batch-enrichment-output.ipynb; \
		echo "✅ Full enrichment complete"; \
	else \
		echo "❌ Cancelled"; \
	fi

# Start Jupyter notebook server
notebook:
	@echo "📓 Starting Jupyter notebook server..."
	@echo "📊 Database: $(DATABASE_URL)"
	@echo ""
	DATABASE_URL=$(DATABASE_URL) jupyter notebook

# Install logo processing dependencies (optional, for full logo processing)
install-logo-processing:
	@echo "📦 Installing logo processing dependencies..."
	@echo "⚠️  This includes heavy ML dependencies (rembg, easyocr)"
	@echo ""
	pip install rembg>=2.0.50 onnxruntime>=1.15.0 easyocr>=1.7.1 opencv-contrib-python>=4.8.0 'numpy<2.0.0'
	@echo "✅ Logo processing dependencies installed"

# Check enrichment status
enrich-status:
	@echo "📊 ENRICHMENT STATUS"
	@echo "========================================"
	@echo ""
	@echo "1️⃣  Companies by enrichment status:"
	@psql "$(DATABASE_URL)" -c "SELECT enrichment_status, COUNT(*) FROM \"company-metadata\" GROUP BY enrichment_status ORDER BY COUNT(*) DESC;"
	@echo ""
	@echo "2️⃣  Companies with logos:"
	@psql "$(DATABASE_URL)" -c "SELECT COUNT(*) as with_logo FROM \"company-metadata\" WHERE logo_gcs_url IS NOT NULL AND logo_gcs_url != '';"
	@echo ""
	@echo "3️⃣  Companies needing enrichment:"
	@psql "$(DATABASE_URL)" -c "SELECT COUNT(*) as needs_enrichment FROM \"company-metadata\" WHERE enrichment_status IS NULL OR enrichment_status = '' OR enrichment_status = 'pending';"
	@echo ""
	@echo "========================================"

# Clear enrichment checkpoint (to restart from scratch)
enrich-reset:
	@echo "🔄 Resetting enrichment checkpoint..."
	@rm -f data/batch_enrichment_checkpoint.json
	@echo "✅ Checkpoint cleared - enrichment will start from the beginning"


# ---------------------------------------------------------------------------
# Register of Interests — quality notebook
# ---------------------------------------------------------------------------
# The preflight below exists because "internal server error" in JupyterLab is
# almost never JupyterLab: it is a stopped database, a kernel missing psycopg2,
# or a notebook that does not round-trip (a 4.5 notebook with no cell ids will
# 500 on save). Each check names the fix rather than the symptom.

NOTEBOOK      ?= register_quality.ipynb
NOTEBOOK_DIR  ?= notebooks
NOTEBOOK_PORT ?= 8888
# Whichever interpreter runs jupyter must be the one with the deps — asking
# `jupyter` avoids guessing between system python, homebrew and a venv.
JUPYTER       ?= jupyter

.PHONY: register-notebook register-notebook-check register-notebook-fix register-notebook-smoke

register-notebook: register-notebook-check
	@echo ""
	@echo "🚀 Starting JupyterLab on port $(NOTEBOOK_PORT)…"
	@echo "   Notebook: $(NOTEBOOK_DIR)/$(NOTEBOOK)"
	@echo "   Stop with Ctrl-C."
	@cd $(NOTEBOOK_DIR) && DATABASE_URL="$(DATABASE_URL)" \
		JUPYTERLAB_DIR="$$(./find_lab_dir.sh)" \
		$(JUPYTER) lab "$(NOTEBOOK)" --port $(NOTEBOOK_PORT)

## Everything that must be true BEFORE the browser opens.
register-notebook-check:
	@echo "🔎 Preflight for $(NOTEBOOK_DIR)/$(NOTEBOOK)"
	@echo ""
	@printf "  jupyter…            "
	@command -v $(JUPYTER) >/dev/null 2>&1 \
		&& echo "ok ($$($(JUPYTER) lab --version 2>/dev/null || echo '?'))" \
		|| { echo "MISSING"; echo ""; echo "   Fix: pip install jupyterlab"; exit 1; }
	@printf "  kernel deps…        "
	@$(JUPYTER) run --help >/dev/null 2>&1 || true
	@python3 -c "import pandas, psycopg2" 2>/dev/null \
		&& echo "ok (pandas + psycopg2)" \
		|| { echo "MISSING"; echo ""; \
		     echo "   The notebook needs ONLY pandas and psycopg2 (no SQLAlchemy)."; \
		     echo "   Fix: pip install pandas psycopg2-binary"; exit 1; }
	@printf "  database…           "
	@psql "$(DATABASE_URL)" -tAc "SELECT 1" >/dev/null 2>&1 \
		&& echo "ok" \
		|| { echo "UNREACHABLE"; echo ""; \
		     echo "   $(DATABASE_URL)"; \
		     echo "   Fix: cd sql && docker compose up -d postgres   (from analysis/)"; \
		     echo "        (if Docker itself is down: orb start)"; exit 1; }
	@printf "  register tables…    "
	@psql "$(DATABASE_URL)" -tAc "SELECT to_regclass('public.register_documents') IS NOT NULL" 2>/dev/null | grep -q t \
		&& echo "ok" \
		|| { echo "ABSENT"; echo ""; \
		     echo "   The register migrations have not been applied to this database."; \
		     echo "   Fix: cd ../services && make migrate-up"; exit 1; }
	@printf "  corpus loaded…      "
	@docs=$$(psql "$(DATABASE_URL)" -tAc "SELECT count(*) FROM register_documents" 2>/dev/null); \
	 rows=$$(psql "$(DATABASE_URL)" -tAc "SELECT count(*) FROM mv_register_public_holdings" 2>/dev/null); \
	 if [ "$${docs:-0}" -gt 0 ]; then \
	   echo "ok ($$docs documents, $$rows published rows)"; \
	 else \
	   echo "EMPTY"; \
	   echo ""; \
	   echo "   Tables exist but hold nothing. The notebook will open and show zeroes."; \
	   echo "   Fix (operator pipeline, see docs/feature/politicians/architecture.md §5.2):"; \
	   echo "     cd ../services/influence-collector"; \
	   echo "     REGISTER_DRY_RUN=false go run . -mode register-load"; \
	   echo "     REGISTER_DRY_RUN=false go run . -mode register-resolve"; \
	 fi
	@printf "  jupyterlab assets…  "
	@labdir=$$($(NOTEBOOK_DIR)/find_lab_dir.sh); \
	 if [ -n "$$labdir" ]; then \
	   recorded=$$($(JUPYTER) lab path 2>/dev/null | awk -F: '/Application directory/ {sub(/^[ \t]+/,"",$$2); print $$2}'); \
	   if [ "$$labdir" = "$$recorded" ]; then echo "ok"; \
	   else echo "ok (repaired)"; \
	        echo "     Jupyter's recorded app dir is stale — usually a Homebrew python"; \
	        echo "     point-upgrade deleting the old Cellar tree. Opening a notebook"; \
	        echo "     against it returns HTTP 500 with TemplateNotFound: index.html."; \
	        echo "     Using: $$labdir"; fi; \
	 else \
	   echo "BROKEN"; echo ""; \
	   echo "   No JupyterLab application directory contains static/index.html."; \
	   echo "   Opening a notebook will return 500 (internal server error)."; \
	   echo "   Fix: pip install --force-reinstall jupyterlab"; exit 1; \
	 fi
	@printf "  notebook format…    "
	@python3 -c "import json,sys; nb=json.load(open('$(NOTEBOOK_DIR)/$(NOTEBOOK)')); \
	 missing=[i for i,c in enumerate(nb['cells']) if 'id' not in c]; \
	 sys.exit(1 if (nb.get('nbformat_minor',0)>=5 and missing) else 0)" 2>/dev/null \
		&& echo "ok" \
		|| { echo "INVALID"; echo ""; \
		     echo "   Cells are missing 'id' but the notebook declares nbformat >= 4.5."; \
		     echo "   JupyterLab returns 500 (internal server error) when it cannot save this."; \
		     echo "   Fix: make register-notebook-fix"; exit 1; }
	@echo ""
	@echo "✅ Preflight passed."

## Repair a notebook that JupyterLab refuses to save.
.PHONY:
register-notebook-fix:
	@echo "🔧 Repairing $(NOTEBOOK_DIR)/$(NOTEBOOK)…"
	@python3 $(NOTEBOOK_DIR)/normalize_ids.py "$(NOTEBOOK_DIR)/$(NOTEBOOK)"
	@echo "✅ Fixed. Run: make register-notebook"

## Execute headlessly and fail on any cell error — use before committing.
.PHONY:
register-notebook-smoke: register-notebook-check
	@echo ""
	@echo "🧪 Executing $(NOTEBOOK) headlessly…"
	@cd $(NOTEBOOK_DIR) && DATABASE_URL="$(DATABASE_URL)" $(JUPYTER) nbconvert \
		--to notebook --execute "$(NOTEBOOK)" --output /tmp/register_quality_smoke.ipynb \
		--ExecutePreprocessor.timeout=300 >/dev/null 2>&1 \
		&& python3 -c "import json,sys; nb=json.load(open('/tmp/register_quality_smoke.ipynb')); \
		   e=[o for c in nb['cells'] for o in c.get('outputs',[]) if o.get('output_type')=='error']; \
		   print(f'  {len(e)} cell error(s)'); sys.exit(1 if e else 0)" \
		|| { echo "❌ Execution failed"; exit 1; }
	@echo "✅ Notebook runs clean."
