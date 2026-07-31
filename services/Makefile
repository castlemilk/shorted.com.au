BASE_URL := http://localhost:9091
GOOGLE_APPLICATION_CREDENTIALS := shorted-dev-aba5688f-4a322ff163b9.json
SHORTS_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts
SHORTS_VERSION := `git describe --tags --always --dirty`
SHORTS_SYNC_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/short-data-sync
STOCK_PRICE_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/stock-price-ingestion
SHORTS_DATABASE_URL := postgresql://admin:password@postgres:5432/shorts

# Default database URL for local development
# Note: Local docker-compose (in ../analysis/sql) uses admin/password on port 5438
DATABASE_URL ?= postgresql://admin:password@localhost:5438/shorts?sslmode=disable

# Algolia configuration for search
ALGOLIA_APP_ID ?= 1BWAPWSTDD
ALGOLIA_SEARCH_KEY ?= 0e5adba5fd8aa4b3848255a39c1287ef
ALGOLIA_INDEX ?= stocks

MIGRATION_PATH := migrations

define kill_pids_in_project_by_pattern
for pid in $$(pgrep -f "$(1)" 2>/dev/null); do \
	cwd=$$(lsof -a -p $$pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1); \
	if [ -n "$$cwd" ] && printf '%s\n' "$$cwd" | grep -q "^$(CURDIR)"; then \
		kill $(2) $$pid 2>/dev/null || true; \
	fi; \
done
endef

define kill_pids_in_project_by_port
for pid in $$(lsof -ti:$(1) 2>/dev/null); do \
	cwd=$$(lsof -a -p $$pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1); \
	if [ -n "$$cwd" ] && printf '%s\n' "$$cwd" | grep -q "^$(CURDIR)"; then \
		kill $(2) $$pid 2>/dev/null || true; \
	fi; \
done
endef



# Database migration commands
.PHONY: migrate-install migrate-up migrate-down migrate-create migrate-force migrate-version migrate-status

migrate-install:
	@echo "📦 Installing go-migrate..."
	@brew install golang-migrate || go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

migrate-up:
	@echo "🚀 Running migrations up..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" up

migrate-down:
	@echo "⬇️ Rolling back one migration..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" down 1

migrate-down-all:
	@echo "⬇️ Rolling back all migrations..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" down -all

migrate-force:
	@echo "⚠️ Force setting migration version to $(VERSION)..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" force $(VERSION)

migrate-version:
	@echo "📌 Current migration version:"
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" version

migrate-create:
	@if [ -z "$(NAME)" ]; then echo "❌ Please provide NAME=<migration_name>"; exit 1; fi
	@echo "✨ Creating new migration: $(NAME)"
	@migrate create -ext sql -dir migrations -seq $(NAME)

# Migration commands for production database
migrate-up-prod:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🚀 Running migrations on production..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" up

migrate-down-prod:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "⬇️ Rolling back one migration on production..."
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" down 1

migrate-version-prod:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "📌 Current migration version:"
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" version

migrate-status-prod:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "📊 Migration status:"
	@migrate -path $(MIGRATION_PATH) -database "$(DATABASE_URL)" version

gcloud.init:
	gcloud artifacts repositories create shorted \
    --repository-format=docker \
    --location="australia-southeast2" \
    --description="shorts service image" \
    --immutable-tags \
    --async

# Clean up any existing processes on port 9091
.PHONY: clean.shorts
clean.shorts:
	@echo "🧹 Cleaning up existing shorts service..."
	@$(call kill_pids_in_project_by_port,9091,-9)
	@$(call kill_pids_in_project_by_pattern,go run shorts/cmd/server/main.go,-9)
	@sleep 1

# Clean up any existing processes on port 8090
.PHONY: clean.market-data
clean.market-data:
	@echo "🧹 Cleaning up existing market data service..."
	@$(call kill_pids_in_project_by_port,8090,-9)
	@$(call kill_pids_in_project_by_pattern,go run market-data/main.go,-9)
	@$(call kill_pids_in_project_by_pattern,market-data-service,-9)
	@sleep 1

run.shorts: clean.shorts
	@echo "🚀 Starting shorts service on port 9091..."
	@echo "   Database: $(DATABASE_URL)"
	@echo "   Algolia: $(ALGOLIA_APP_ID) / $(ALGOLIA_INDEX)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			if [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
				export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
			fi; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		export GCP_PROJECT_ID="$${GCP_PROJECT_ID:-shorted-dev-aba5688f}"; \
		export ALGOLIA_APP_ID="$(ALGOLIA_APP_ID)"; \
		export ALGOLIA_SEARCH_KEY="$(ALGOLIA_SEARCH_KEY)"; \
		export ALGOLIA_INDEX="$(ALGOLIA_INDEX)"; \
		go run shorts/cmd/server/main.go \
	'

run.market-data: clean.market-data
	@echo "🚀 Starting market data service on port 8090..."
	@echo "   Database: $(DATABASE_URL)"
	@cd market-data && DATABASE_URL=$(DATABASE_URL) go run main.go validation.go 

.PHONY: clean.enrichment-processor
clean.enrichment-processor:
	@echo "🧹 Cleaning up existing enrichment processor..."
	@for pid in $$(pgrep -f "enrichment-processor" 2>/dev/null); do \
		cwd=$$(lsof -a -p $$pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1); \
		if [ -n "$$cwd" ] && printf '%s\n' "$$cwd" | grep -q "^$(CURDIR)"; then \
			echo "Killing enrichment processor process $$pid and its children..."; \
			pkill -P $$pid 2>/dev/null || true; \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done || true
	@$(call kill_pids_in_project_by_pattern,enrichment-processor,-9)
	@sleep 1

.PHONY: setup.enrichment-processor.venv
setup.enrichment-processor.venv:
	@echo "🐍 Setting up Python virtual environment for enrichment processor..."
	@cd enrichment-processor && \
	if [ ! -d "venv" ]; then \
		python3 -m venv venv; \
	fi && \
	. venv/bin/activate && \
	pip install --upgrade pip && \
	pip install -r requirements.txt && \
	if [ ! -f "mobile_sam.pt" ]; then \
		echo "📥 Downloading MobileSAM checkpoint..."; \
		wget -q https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -O mobile_sam.pt || \
		curl -L https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -o mobile_sam.pt; \
	fi && \
	echo "✅ Virtual environment setup complete!"

.PHONY: install.enrichment-processor.deps
install.enrichment-processor.deps: setup.enrichment-processor.venv
	@echo "✅ Dependencies installed in venv"

run.enrichment-processor: clean.enrichment-processor
	@echo "🚀 Starting enrichment processor..."
	@echo "   Database: $(DATABASE_URL)"
	@if [ ! -d "enrichment-processor/venv" ]; then \
		echo "⚠️  Warning: Python venv not found. Run 'make setup.enrichment-processor.venv' to set up dependencies."; \
	fi
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export APP_STORE_POSTGRES_ADDRESS="$${APP_STORE_POSTGRES_ADDRESS:-localhost:5438}"; \
		export APP_STORE_POSTGRES_DATABASE="$${APP_STORE_POSTGRES_DATABASE:-shorts}"; \
		export APP_STORE_POSTGRES_USERNAME="$${APP_STORE_POSTGRES_USERNAME:-admin}"; \
		export APP_STORE_POSTGRES_PASSWORD="$${APP_STORE_POSTGRES_PASSWORD:-password}"; \
		export OPENAI_API_KEY="$${OPENAI_API_KEY}"; \
		export GEMINI_API_KEY="$${GEMINI_API_KEY}"; \
		export ENRICHMENT_MODEL="$${ENRICHMENT_MODEL:-openai}"; \
		export EXA_API_KEY="$${EXA_API_KEY}"; \
		export GCS_LOGO_BUCKET="$${GCS_LOGO_BUCKET}"; \
		export LOGO_DISCOVERY_ENABLED="$${LOGO_DISCOVERY_ENABLED:-true}"; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		go run ./enrichment-processor/ \
	'

build.short-data-sync:
	cd short-data-sync; docker buildx build --push --progress=plain --platform linux/amd64,linux/arm64 -f Dockerfile -t ${SHORTS_SYNC_IMAGE}:latest -t ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} .
build.shorts:
	docker buildx build --push --progress=plain --platform linux/amd64,darwin/arm64,linux/arm64/v8 -f shorts/cmd/server/Dockerfile -t ${SHORTS_IMAGE}:${SHORTS_VERSION} .
	# docker buildx build --load -f shorts/cmd/server/Dockerfile -t ${SHORTS_IMAGE}:${SHORTS_VERSION} .
gcr.init:
	gcloud auth configure-docker asia.gcr.io
gcr.push:
	docker push ${SHORTS_IMAGE}:${SHORTS_VERSION}

run.docker.shorts-data-sync.local.standalone:
	docker run \
		-e DATABASE_URL=${SHORTS_DATABASE_URL} \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/${GOOGLE_APPLICATION_CREDENTIALS} \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/${GOOGLE_APPLICATION_CREDENTIALS}:/app/${GOOGLE_APPLICATION_CREDENTIALS} \
	 --link postgres -it --net sql_default --entrypoint "python" ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} main.py

run.docker.shorts-data-sync.local:
	docker run \
		-e DATABASE_URL=${SHORTS_DATABASE_URL} \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/${GOOGLE_APPLICATION_CREDENTIALS} \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/${GOOGLE_APPLICATION_CREDENTIALS}:/app/${GOOGLE_APPLICATION_CREDENTIALS} \
	 --link postgres --net sql_default -p 9091:9091  ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION}

run.docker.shorts-data-sync.local.job:
	docker run \
		-e DATABASE_URL=${SHORTS_DATABASE_URL} \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/${GOOGLE_APPLICATION_CREDENTIALS} \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/${GOOGLE_APPLICATION_CREDENTIALS}:/app/${GOOGLE_APPLICATION_CREDENTIALS} \
	 --link postgres --net sql_default --entrypoint python ${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} main.py

run.docker.shorts-data-sync.supabase.job:
	docker run \
		-e DATABASE_URL=${DATABASE_URL} \
		-e GOOGLE_APPLICATION_CREDENTIALS=/app/shorted-dev-aba5688f-c627abe05e3d.json \
		-v $(PWD)/../analysis/data/shorts/:/app/data/shorts/ \
		-v $(PWD)/short-data-sync/shorted-dev-aba5688f-c627abe05e3d.json:/app/shorted-dev-aba5688f-c627abe05e3d.json \
		--entrypoint python \
		${SHORTS_SYNC_IMAGE}:${SHORTS_VERSION} main.py

run.docker.shorts.local:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=postgres:5432 \
	 --link postgres --net sql_default -p 9091:9091 --name sync-service shorts:latest 
run.docker.shorts.superbase:
	docker run \
		-e APP_STORE_POSTGRES_ADDRESS=aws-0-ap-southeast-2.pooler.supabase.com:6543 \
		-e APP_STORE_POSTGRES_DATABASE=postgres \
		-e APP_STORE_POSTGRES_USERNAME=postgres.xivfykscsdagwsreyqgf \
		-e APP_STORE_POSTGRES_PASSWORD=6tOCck692RrQJzXL \
	 --link postgres --net sql_default -p 9091:9091 --name shorts-service ${SHORTS_IMAGE}:${SHORTS_VERSION}
deploy.gcr.shorts:
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_IMAGE} envsubst < shorts/cmd/server/service.template.yaml > shorts/cmd/server/service.yaml && \
	gcloud run services replace shorts/cmd/server/service.yaml --region australia-southeast2

deploy.job.shorts-data-sync: build.short-data-sync
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_SYNC_IMAGE} envsubst < short-data-sync/job.template.yaml > short-data-sync/job.yaml && \
	gcloud run jobs replace --region australia-southeast2 short-data-sync/job.yaml

deploy.gcr.shorts-data-sync:
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${SHORTS_SYNC_IMAGE} envsubst < short-data-sync/service.template.yaml > short-data-sync/service.yaml && \
	gcloud run services replace short-data-sync/service.yaml --region australia-southeast2

build.stock-price-ingestion:
	cd stock-price-ingestion && docker buildx build --push --progress=plain --platform linux/amd64 -f Dockerfile -t ${STOCK_PRICE_IMAGE}:latest -t ${STOCK_PRICE_IMAGE}:${SHORTS_VERSION} .

deploy.gcr.stock-price-ingestion: build.stock-price-ingestion
	VERSION=${SHORTS_VERSION} IMAGE_NAME=${STOCK_PRICE_IMAGE} envsubst < stock-price-ingestion/service.template.yaml > stock-price-ingestion/service.yaml && \
	gcloud run services replace stock-price-ingestion/service.yaml --region australia-southeast2

# ko-based image builds (pure Go services)
KO_DOCKER_REPO_BASE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted

.PHONY: ko.build.market-data ko.build.weekly-report ko.local.market-data ko.local.weekly-report

ko.build.market-data:
	@echo "🏗️ Building market-data with ko..."
	KO_DOCKER_REPO=$(KO_DOCKER_REPO_BASE)/market-data ko build ./market-data --bare --platform=linux/amd64 --tags="$(SHORTS_VERSION),latest"

ko.build.weekly-report:
	@echo "🏗️ Building weekly-report-generator with ko..."
	KO_DOCKER_REPO=$(KO_DOCKER_REPO_BASE)/weekly-report-generator ko build ./weekly-report-generator --bare --platform=linux/amd64 --tags="$(SHORTS_VERSION),latest"

ko.local.market-data:
	@echo "🏗️ Building market-data locally with ko..."
	ko build ./market-data --local --bare --platform=linux/amd64

ko.local.weekly-report:
	@echo "🏗️ Building weekly-report-generator locally with ko..."
	ko build ./weekly-report-generator --local --bare --platform=linux/amd64

test.gettopshorts:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1m", "limit": 10}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetTopShorts -v | jq -r

test.gettopshorts.rest:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "1m", "limit": 10}' \
    $(BASE_URL)/v1/topShorts -v | jq -r

test.getstock:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "BOE"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStock -v

test.getstockdetails:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "BOE"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStockDetails -v


test.getstockdata:
	curl \
    --header "Content-Type: application/json" \
	--data '{"productCode": "BOE", "period": "1M"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetStockData -v


test.gettreemap:
	curl \
    --header "Content-Type: application/json" \
	--data '{"period": "3m", "limit": "10"}' \
    $(BASE_URL)/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap -v

generate.statik:
	statik -src=../api/schema -f -include=openapi.yaml -dest=./shorts/internal/api/schema

# Weekly report generator commands
.PHONY: report-generate report-rerun report-dry-run

report-generate:
	@echo "Generating weekly report for $(or $(WEEK),current week)..."
	@bash -c 'DATABASE_URL="$(DATABASE_URL)" go run ./weekly-report-generator/ $(if $(WEEK),--week=$(WEEK)) $(if $(MONTH),--month=$(MONTH)) $(if $(YEAR),--year=$(YEAR))'

report-rerun:
	@echo "Re-generating report with --force..."
	@bash -c 'DATABASE_URL="$(DATABASE_URL)" go run ./weekly-report-generator/ --force --max-retries=$(or $(RETRIES),3) $(if $(WEEK),--week=$(WEEK)) $(if $(MONTH),--month=$(MONTH)) $(if $(YEAR),--year=$(YEAR))'

report-dry-run:
	@echo "Dry-run report generation..."
	@bash -c 'DATABASE_URL="$(DATABASE_URL)" go run ./weekly-report-generator/ --dry-run $(if $(WEEK),--week=$(WEEK)) $(if $(MONTH),--month=$(MONTH)) $(if $(YEAR),--year=$(YEAR))'

# Data population commands
.PHONY: build.populate-data run.populate-data populate-data populate-data-quick populate-data-force populate-data-1y populate-data-force-reload

build.populate-data:
	go build -o bin/populate-data ./cmd/populate-data

run.populate-data: build.populate-data
	./bin/populate-data

populate-data: build.populate-data
	@echo "🚀 Starting full data population (all ASIC data back to 2010, ~4000 files)..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data

populate-data-quick: build.populate-data
	@echo "🚀 Quick data population (skips download, processes existing files)..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data --skip-download

populate-data-force: build.populate-data
	@echo "🚀 Force data population (re-downloads all files)..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data --force-download

populate-data-recent: build.populate-data
	@echo "🚀 Populating with recent 30 days only..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data --limit=30

populate-data-1y: build.populate-data
	@echo "🚀 Populating with 1 year of data (~260 trading days)..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data --limit=260

populate-data-force-reload: build.populate-data
	@echo "🚀 Force reloading ALL data (truncates table first)..."
	@DATABASE_URL=${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts} ./bin/populate-data --force-reload

# Stock price data backfill commands
.PHONY: history.stock-data.backfill history.stock-data.backfill-test history.stock-data.backfill-full history.stock-data.status

history.stock-data.setup:
	@echo "📦 Setting up Python environment for backfill..."
	@cd stock-price-ingestion && python3 -m venv venv 2>/dev/null || true
	@cd stock-price-ingestion && source venv/bin/activate && pip install -q asyncpg yfinance tqdm pandas
	@echo "✅ Environment ready"

history.stock-data.backfill-test: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🧪 Running test backfill (10 stocks, 1 year)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_historical.py --limit 10 --years 1 --batch-size 5 --delay 0.5

history.stock-data.backfill: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🚀 Running standard backfill (all stocks, 2 years)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_historical.py --years 2 --batch-size 10 --delay 1.0

history.stock-data.backfill-optimized: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "⚡ Running OPTIMIZED backfill (with caching & batch downloads)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_historical_optimized.py --years 2 --batch-size 50

history.stock-data.clear-cache:
	@echo "🗑️ Clearing backfill cache..."
	@rm -f stock-price-ingestion/stock_backfill_cache.pkl
	@echo "✅ Cache cleared"

history.stock-data.backfill-delisted: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🏚️ Backfilling historical data for delisted stocks..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_delisted.py $(if $(LIMIT),--limit $(LIMIT))

history.stock-data.backfill-delisted-test: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🧪 Testing delisted backfill (10 stocks)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_delisted.py --limit 10

history.stock-data.backfill-full: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "🌍 Running full backfill (all stocks, 5 years)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_historical.py --years 5 --batch-size 20 --delay 0.5

history.stock-data.backfill-custom: history.stock-data.setup
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@if [ -z "$(YEARS)" ]; then echo "❌ Please provide YEARS=<years>"; exit 1; fi
	@echo "📊 Running custom backfill ($(YEARS) years)..."
	@cd stock-price-ingestion && source venv/bin/activate && \
		DATABASE_URL="$(DATABASE_URL)" python backfill_historical.py --years $(YEARS) \
		--batch-size $${BATCH_SIZE:-10} \
		--delay $${DELAY:-1.0} \
		$$(if [ -n "$(LIMIT)" ]; then echo "--limit $(LIMIT)"; fi)

history.stock-data.status:
	@if [ -z "$(DATABASE_URL)" ]; then echo "❌ DATABASE_URL not set"; exit 1; fi
	@echo "📊 Stock price data status:"
	@echo "=========================="
	@psql "$(DATABASE_URL)" -t -c \
		"SELECT 'Total stocks with price data: ' || COUNT(DISTINCT stock_code) FROM stock_prices" 2>/dev/null
	@psql "$(DATABASE_URL)" -t -c \
		"SELECT 'Total price records: ' || COUNT(*) FROM stock_prices" 2>/dev/null
	@psql "$(DATABASE_URL)" -t -c \
		"SELECT 'Date range: ' || MIN(date)::text || ' to ' || MAX(date)::text FROM stock_prices" 2>/dev/null
	@echo ""
	@echo "Top 10 stocks by record count:"
	@psql "$(DATABASE_URL)" -c \
		"SELECT stock_code, COUNT(*) as records FROM stock_prices GROUP BY stock_code ORDER BY records DESC LIMIT 10" 2>/dev/null

# ASX Discovery & Market Data Sync
.PHONY: run.asx-discovery run.market-data-sync run.market-data-sync-cli run.market-data-sync-with-algolia
.PHONY: test.asx-discovery test.market-data-sync test.market-data-sync-integration
.PHONY: build.asx-discovery build.market-data-sync push.asx-discovery push.market-data-sync
.PHONY: backfill.historical backfill.historical-symbol backfill.historical-force backfill.historical-test

ASX_DISCOVERY_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/asx-discovery
MARKET_DATA_SYNC_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/market-data-sync

build.asx-discovery:
	@echo "🏗️ Building ASX discovery image..."
	cd asx-discovery && docker build --platform linux/amd64 -t $(ASX_DISCOVERY_IMAGE):latest -t $(ASX_DISCOVERY_IMAGE):$(SHORTS_VERSION) .

push.asx-discovery: build.asx-discovery
	@echo "⬆️ Pushing ASX discovery image..."
	docker push $(ASX_DISCOVERY_IMAGE):latest
	docker push $(ASX_DISCOVERY_IMAGE):$(SHORTS_VERSION)

build.market-data-sync:
	@echo "🏗️ Building market data sync image..."
	docker build --platform linux/amd64 -t $(MARKET_DATA_SYNC_IMAGE):latest -t $(MARKET_DATA_SYNC_IMAGE):$(SHORTS_VERSION) -f market-data-sync/Dockerfile .

push.market-data-sync: build.market-data-sync
	@echo "⬆️ Pushing market data sync image..."
	docker push $(MARKET_DATA_SYNC_IMAGE):latest
	docker push $(MARKET_DATA_SYNC_IMAGE):$(SHORTS_VERSION)

run.asx-discovery:
	@echo "🚀 Running ASX discovery service..."
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd asx-discovery && go run main.go \
	'

run.market-data-sync:
	@echo "🚀 Running market data sync API server..."
	@echo "   Database: $(DATABASE_URL)"
	@echo "   GCS Bucket: $${GCS_BUCKET_NAME:-shorted-data}"
	@echo "   Priority Stocks: $${PRIORITY_STOCK_COUNT:-100}"
	@echo "   Port: $${PORT:-8080}"
	@echo "   Alpha Vantage: $${ALPHA_VANTAGE_API_KEY:+enabled}"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		export PRIORITY_STOCK_COUNT=$${PRIORITY_STOCK_COUNT:-100}; \
		export PORT=$${PORT:-8080}; \
		export ALPHA_VANTAGE_API_KEY="$${ALPHA_VANTAGE_API_KEY}"; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run . \
	'

run.market-data-sync-cli:
	@echo "🚀 Running market data sync in CLI mode (full sync)..."
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		export PRIORITY_STOCK_COUNT=$${PRIORITY_STOCK_COUNT:-100}; \
		export ALPHA_VANTAGE_API_KEY="$${ALPHA_VANTAGE_API_KEY}"; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run . -cli \
	'

run.market-data-sync-with-algolia:
	@echo "🚀 Running market data sync with Algolia..."
	@echo "   Database: $(DATABASE_URL)"
	@echo "   Algolia: $(ALGOLIA_APP_ID)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		export PRIORITY_STOCK_COUNT=$${PRIORITY_STOCK_COUNT:-100}; \
		export SYNC_ALGOLIA=true; \
		export ALGOLIA_APP_ID="$(ALGOLIA_APP_ID)"; \
		export ALGOLIA_ADMIN_KEY="$${ALGOLIA_ADMIN_KEY}"; \
		export ALGOLIA_INDEX="$(ALGOLIA_INDEX)"; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run . \
	'

# ---------------------------------------------------------------------------
# Register of Interests -> Algolia `politicians` index
#
# CREDENTIALS LIVE IN services/.env (gitignored). See .env.example for the keys.
# You should never need to export anything by hand.
#
# THE DATABASE_URL OVERRIDE BELOW IS LOAD-BEARING, not boilerplate. services/.env
# holds the PRODUCTION Supabase URL — it is the file operators use for prod DDL.
# Sourcing it would silently point a "local" index build at prod, so DATABASE_URL
# is re-exported from the Makefile default AFTER the source, exactly as
# run.shorts and run.market-data-sync-with-algolia do. Pass DATABASE_URL=... on
# the command line to target prod deliberately.
#
# Run this AFTER register-resolve: it reads mv_register_public_holdings, which
# resolve rebuilds. An index built before the refresh advertises stale matches.
ALGOLIA_POLITICIANS_INDEX ?= politicians

.PHONY: register-index register-index-dry register-index-env

define register_index_run
	@bash -c ' \
		if [ -f .env ]; then set -a; source .env; set +a; fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export ALGOLIA_APP_ID="$${ALGOLIA_APP_ID:-$(ALGOLIA_APP_ID)}"; \
		export ALGOLIA_POLITICIANS_INDEX="$(ALGOLIA_POLITICIANS_INDEX)"; \
		export REGISTER_DRY_RUN=$(1); \
		echo "   database: $$(echo "$$DATABASE_URL" | sed -E "s#//[^@]*@#//***@#")"; \
		echo "   index:    $$ALGOLIA_POLITICIANS_INDEX  (app $$ALGOLIA_APP_ID)"; \
		echo "   dry run:  $$REGISTER_DRY_RUN"; \
		if [ "$(1)" != "true" ] && [ -z "$$ALGOLIA_WRITE_KEY" ] && [ -z "$$ALGOLIA_ADMIN_KEY" ]; then \
			echo ""; \
			echo "❌ ALGOLIA_WRITE_KEY is not set."; \
			echo "   Add it to services/.env (see services/.env.example), then re-run."; \
			echo "   A search key cannot write an index — this needs the write/admin key."; \
			exit 1; \
		fi; \
		cd jobs && go run ./cmd/shorted influence -mode register-index \
	'
endef

register-index-dry: ## Preview the politicians Algolia index — reads the DB, writes NOTHING
	@echo "🔍 Previewing the politicians search index (no writes)..."
	$(call register_index_run,true)

register-index: ## Build and push the politicians Algolia index (needs ALGOLIA_WRITE_KEY in .env)
	@echo "🔎 Building the politicians search index..."
	$(call register_index_run,false)

register-index-env: ## Show which Algolia credentials the index build can see (values masked)
	@bash -c ' \
		if [ -f .env ]; then set -a; source .env; set +a; fi; \
		mask() { if [ -z "$$2" ]; then echo "   $$1: (not set)"; else echo "   $$1: set, $${#2} chars"; fi; }; \
		echo "Algolia credentials visible to register-index:"; \
		mask ALGOLIA_APP_ID "$$ALGOLIA_APP_ID"; \
		mask ALGOLIA_WRITE_KEY "$$ALGOLIA_WRITE_KEY"; \
		mask ALGOLIA_ADMIN_KEY "$$ALGOLIA_ADMIN_KEY"; \
		echo "   ALGOLIA_POLITICIANS_INDEX: $(ALGOLIA_POLITICIANS_INDEX)"; \
		echo ""; \
		echo "Source: services/.env (gitignored). Keys are documented in services/.env.example."; \
	'

test.asx-discovery:
	@echo "🧪 Running ASX discovery integration tests..."
	@cd asx-discovery && go test -v -tags=integration ./...

test.market-data-sync:
	@echo "🧪 Running market data sync tests..."
	@cd market-data-sync && go test -v ./...

test.market-data-sync-integration:
	@echo "🧪 Running market data sync integration tests..."
	@cd market-data-sync && go test -v -tags=integration ./...

# Historical Backfill Commands
backfill.historical: ## Backfill historical stock data for all stocks (10 years)
	@echo "📊 Running historical backfill for all stocks (10 years)..."
	@echo "   Database: $(DATABASE_URL)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run ./cmd/historical-backfill -years=10 \
	'

backfill.historical-symbol: ## Backfill historical data for a specific stock (usage: make backfill.historical-symbol SYMBOL=DMP)
	@if [ -z "$(SYMBOL)" ]; then \
		echo "❌ Please provide SYMBOL=<stock_code>"; \
		echo "   Example: make backfill.historical-symbol SYMBOL=DMP"; \
		exit 1; \
	fi
	@echo "📊 Running historical backfill for $(SYMBOL)..."
	@echo "   Database: $(DATABASE_URL)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run ./cmd/historical-backfill -symbol=$(SYMBOL) -years=$${YEARS:-10} \
	'

backfill.historical-force: ## Force re-fetch all historical data (ignores existing records)
	@echo "⚠️  Force mode: Re-fetching ALL historical data..."
	@echo "   Database: $(DATABASE_URL)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run ./cmd/historical-backfill -years=$${YEARS:-10} -force \
	'

backfill.historical-test: ## Test backfill with limited stocks (usage: make backfill.historical-test LIMIT=10 YEARS=2)
	@echo "🧪 Running test backfill ($(or $(LIMIT),10) stocks, $(or $(YEARS),2) years)..."
	@echo "   Database: $(DATABASE_URL)"
	@bash -c ' \
		if [ -f .env ]; then \
			set -a; \
			source .env; \
			set +a; \
		fi; \
		export DATABASE_URL="$(DATABASE_URL)"; \
		export GCS_BUCKET_NAME=$${GCS_BUCKET_NAME:-shorted-data}; \
		if [ -n "$$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$$GOOGLE_APPLICATION_CREDENTIALS" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(cd $$(dirname "$$GOOGLE_APPLICATION_CREDENTIALS") && pwd)/$$(basename "$$GOOGLE_APPLICATION_CREDENTIALS")"; \
		elif [ -f "$(GOOGLE_APPLICATION_CREDENTIALS)" ]; then \
			export GOOGLE_APPLICATION_CREDENTIALS="$$(pwd)/$(GOOGLE_APPLICATION_CREDENTIALS)"; \
		fi; \
		cd market-data-sync && go run ./cmd/historical-backfill -years=$(or $(YEARS),2) -limit=$(or $(LIMIT),10) \
	'

# Test commands
.PHONY: test test.coverage test.shorts test.integration test.integration.local test.integration.docker bench
.PHONY: test-stack-up test-stack-down test-stack-status test-stack-logs
.PHONY: test-integration test-e2e test-all-integration test-integration-local test-integration-ci
.PHONY: lint lint-install

# Linting
lint-install:
	@which golangci-lint > /dev/null || { \
		echo "📦 Installing golangci-lint..."; \
		if [ "$$(uname)" = "Darwin" ]; then \
			brew install golangci-lint; \
		else \
			curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $$(go env GOPATH)/bin v1.61.0; \
		fi; \
	}

lint: lint-install
	@echo "🔍 Running golangci-lint..."
	golangci-lint run ./...

lint-fix: lint-install
	@echo "🔧 Running golangci-lint with auto-fix..."
	golangci-lint run --fix ./...

# Unit tests (use -short to skip E2E tests requiring network/browser)
test:
	go test ./... -v -short

test.coverage:
	go test ./... -v -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html

test.shorts:
	go test ./shorts/... -v

test.topshorts.integration:
	@echo "🧪 Running top shorts integration tests with testcontainers..."
	@echo "⚠️  This requires Docker to be running"
	@echo ""
	cd shorts && go test -v -run TestFetchTimeSeriesData ./internal/store/shorts/ -timeout=5m

test.integration:
	@echo "🧪 Running all integration tests (including market-data)..."
	go test ./... -v -count=1 -tags=integration

# Integration tests - LOCAL development (fully self-contained with testcontainers)
test-integration-local:
	@echo "🧪 Running integration tests..."
	@echo "  📦 Testcontainers will automatically:"
	@echo "    - Start PostgreSQL container"
	@echo "    - Start shorts service"
	@echo "    - Run all tests"
	@echo "    - Clean up everything"
	@echo ""
	@$(MAKE) clean.shorts
	@echo "Running test/integration tests..."
	@cd ../test/integration && go test -v -count=1 -timeout=20m ./...
	@echo ""
	@echo "Running market-data integration tests (with testcontainers)..."
	@cd market-data && go test -v -count=1 -tags=integration -timeout=10m ./...
	@echo ""

# Integration tests - CI (self-contained via testcontainers)
test-integration-ci:
	@echo "🧪 Running integration tests (testcontainers)..."
	@echo "Running test/integration tests..."
	@cd ../test/integration && go test -v -count=1 -timeout=10m ./...
	@echo ""
	@echo "Running market-data integration tests (with testcontainers)..."
	@cd market-data && go test -v -count=1 -tags=integration -timeout=10m ./...

# New integration test targets using testcontainers
test.integration.local:
	@echo "🧪 Running integration tests with testcontainers..."
	go test -count=1 -tags=integration ./test/integration/... -v -timeout=10m

test.integration.docker:
	@echo "🐳 Running integration tests in Docker environment..."
	docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit test-runner

# Test stack management
test-stack-up:
	@echo "🚀 Starting test environment..."
	docker-compose -f docker-compose.test.yml up -d postgres-test redis-test
	@echo "⏳ Waiting for services to be ready..."
	@sleep 10
	@echo "✅ Test stack is ready!"

test-stack-down:
	@echo "🛑 Stopping test environment..."
	docker-compose -f docker-compose.test.yml down -v

test-stack-status:
	@echo "📊 Test environment status:"
	docker-compose -f docker-compose.test.yml ps

test-stack-logs:
	@echo "📋 Test environment logs:"
	docker-compose -f docker-compose.test.yml logs -f

# Migration targets for test database
test-migrate-up:
	@echo "🚀 Running test database migrations..."
	docker-compose -f docker-compose.test.yml up migrate-test

test-migrate-reset:
	@echo "♻️ Resetting test database..."
	docker-compose -f docker-compose.test.yml down -v postgres-test
	docker-compose -f docker-compose.test.yml up -d postgres-test
	@sleep 5
	$(MAKE) test-migrate-up

# Combined integration test targets
test-integration: test.integration.local

test-e2e:
	@echo "🌐 Running end-to-end tests..."
	$(MAKE) test-stack-up
	@sleep 5
	$(MAKE) test.integration.docker
	$(MAKE) test-stack-down

test-all-integration:
	@echo "🔬 Running all integration tests..."
	@echo "1. Local testcontainers tests..."
	$(MAKE) test.integration.local
	@echo "2. Docker environment tests..."
	$(MAKE) test.integration.docker

# Benchmarks
bench:
	go test ./... -bench=. -benchmem

# Test coverage with integration tests
test.coverage.integration:
	@echo "📊 Running integration tests with coverage..."
	go test -count=1 -tags=integration ./test/integration/... -v -timeout=10m -coverprofile=integration-coverage.out
	go tool cover -html=integration-coverage.out -o integration-coverage.html
	@echo "📈 Integration test coverage report generated: integration-coverage.html"

# Clean test artifacts
test-clean:
	@echo "🧹 Cleaning test artifacts..."
	rm -f coverage.out coverage.html integration-coverage.out integration-coverage.html
	docker-compose -f docker-compose.test.yml down -v --remove-orphans
	docker volume prune -f

# Performance and Load Testing Targets
.PHONY: perf-test load-test stress-test spike-test benchmark-test artillery-test
.PHONY: perf-install perf-setup perf-clean perf-report perf-baseline
.PHONY: perf-vegeta perf-k6 perf-artillery perf-all perf-go-tests

# Go-based performance tests (testcontainers, opt-in)
perf-go-tests:
	@echo "🚀 Running Go performance tests with testcontainers..."
	@echo "  This will start PostgreSQL container and shorts service"
	@cd shorts/test/performance && RUN_PERFORMANCE_TESTS=1 go test -v -timeout=30m ./...

# Performance testing setup
perf-install:
	@echo "📦 Installing performance testing tools..."
	@echo "Installing k6..."
	@if ! command -v k6 &> /dev/null; then \
		if [[ "$$(uname)" == "Darwin" ]]; then \
			brew install k6; \
		else \
			curl https://github.com/grafana/k6/releases/download/v0.47.0/k6-v0.47.0-linux-amd64.tar.gz -L | tar xvz --strip-components 1; \
			sudo mv k6 /usr/local/bin/; \
		fi \
	fi
	@echo "Installing Artillery..."
	@npm list -g artillery &> /dev/null || npm install -g artillery
	@echo "Installing Go vegeta..."
	@go install github.com/tsenart/vegeta/v12@latest
	@echo "✅ Performance testing tools installed"

perf-setup: perf-install
	@echo "🔧 Setting up performance test environment..."
	@mkdir -p test/k6/results
	@mkdir -p test/artillery/results
	@mkdir -p services/test/performance/results
	@echo "BASE_URL=http://localhost:9091" > test/.env.perf
	@echo "✅ Performance test environment ready"

# Go-based load testing with vegeta
perf-vegeta:
	@echo "🚀 Running Go/Vegeta load tests..."
	@cd services && go test ./test/performance/load_test.go -v -timeout=60m -run TestGetTopShortsLoadTest
	@cd services && go test ./test/performance/load_test.go -v -timeout=30m -run TestGetStockLoadTest
	@cd services && go test ./test/performance/load_test.go -v -timeout=30m -run TestGetStockDataLoadTest
	@cd services && go test ./test/performance/load_test.go -v -timeout=30m -run TestGetIndustryTreeMapLoadTest

# Go benchmark tests
benchmark-test:
	@echo "⚡ Running Go benchmark tests..."
	@cd services && go test ./test/performance/benchmark_test.go -v -bench=. -benchmem -timeout=30m > test/performance/results/benchmark-results.txt
	@echo "📊 Benchmark results saved to services/test/performance/results/benchmark-results.txt"

# k6 load testing
perf-k6:
	@echo "📈 Running k6 load tests..."
	@cd test && k6 run k6/load-test.js --out json=k6/results/load-test-results.json
	@echo "📊 k6 load test results saved to test/k6/results/"

# k6 stress testing  
stress-test:
	@echo "💪 Running k6 stress tests..."
	@cd test && k6 run k6/stress-test.js --out json=k6/results/stress-test-results.json
	@echo "📊 k6 stress test results saved to test/k6/results/"

# k6 spike testing
spike-test:
	@echo "⚡ Running k6 spike tests..."
	@cd test && k6 run k6/spike-test.js --out json=k6/results/spike-test-results.json
	@echo "📊 k6 spike test results saved to test/k6/results/"

# Artillery load testing
perf-artillery:
	@echo "🎯 Running Artillery load tests..."
	@cd test && artillery run artillery/scenarios.yml --output artillery/results/artillery-results.json
	@cd test && artillery report artillery/results/artillery-results.json --output artillery/results/artillery-report.html
	@echo "📊 Artillery results saved to test/artillery/results/"

# Comprehensive load testing - runs all tools
load-test: perf-setup
	@echo "🔄 Running comprehensive load testing suite..."
	@$(MAKE) benchmark-test
	@$(MAKE) perf-vegeta
	@$(MAKE) perf-k6
	@$(MAKE) perf-artillery
	@echo "✅ Comprehensive load testing completed"

# Performance testing with specific scenarios
perf-test: perf-setup
	@echo "🧪 Running standard performance tests..."
	@$(MAKE) benchmark-test
	@$(MAKE) perf-k6
	@echo "✅ Performance testing completed"

# All performance tests including stress and spike
perf-all: perf-setup
	@echo "🎯 Running ALL performance tests..."
	@$(MAKE) benchmark-test
	@$(MAKE) perf-vegeta
	@$(MAKE) perf-k6
	@$(MAKE) stress-test
	@$(MAKE) spike-test
	@$(MAKE) perf-artillery
	@echo "✅ All performance tests completed"

# Concurrent user testing
perf-concurrent:
	@echo "👥 Running concurrent user tests..."
	@cd services && go test ./test/performance/load_test.go -v -timeout=30m -run TestConcurrentUsersScenario
	@echo "📊 Concurrent user test results logged"

# Database connection pool testing
perf-db-pool:
	@echo "🗄️ Running database connection pool tests..."
	@cd services && go test ./test/performance/load_test.go -v -timeout=15m -run TestDatabaseConnectionPoolUnderLoad
	@cd services && go test ./test/performance/benchmark_test.go -v -bench=BenchmarkDatabaseConnectionPool -benchmem
	@echo "📊 Database connection pool test completed"

# Sustained load testing (15 minutes)
perf-sustained:
	@echo "⏰ Running sustained load test (15 minutes)..."
	@cd services && go test ./test/performance/load_test.go -v -timeout=20m -run TestSustainedLoad
	@echo "📊 Sustained load test completed"

# Cache effectiveness testing
perf-cache:
	@echo "💾 Running cache effectiveness tests..."
	@cd services && go test ./test/performance/benchmark_test.go -v -bench=BenchmarkCacheEffectiveness -benchmem
	@cd test && k6 run --duration 5m --vus 20 -e SCENARIO=cache k6/load-test.js
	@echo "📊 Cache effectiveness test completed"

# Memory usage testing
perf-memory:
	@echo "🧠 Running memory usage tests..."
	@cd services && go test ./test/performance/benchmark_test.go -v -bench=BenchmarkMemoryUsage -benchmem
	@echo "📊 Memory usage test completed"

# Performance baseline validation
perf-baseline:
	@echo "📏 Validating against performance baseline..."
	@cd test && k6 run --duration 10m --vus 50 k6/load-test.js
	@echo "🔍 Comparing results against test/performance-baseline.json..."
	@echo "📊 Review load-test-results.html for baseline comparison"

# Performance regression testing
perf-regression:
	@echo "🔄 Running performance regression tests..."
	@$(MAKE) perf-baseline
	@echo "⚠️ Compare results with previous baseline measurements"
	@echo "📈 Check for performance degradation > 20%"

# Generate performance reports
perf-report:
	@echo "📊 Generating performance test reports..."
	@cd services && if [ -f test/performance/results/benchmark-results.txt ]; then \
		echo "=== Go Benchmark Results ===" > test/performance/results/performance-summary.txt; \
		cat test/performance/results/benchmark-results.txt >> test/performance/results/performance-summary.txt; \
	fi
	@cd test && if [ -d k6/results ]; then \
		echo "\n=== k6 Test Results ===" >> ../services/test/performance/results/performance-summary.txt; \
		find k6/results -name "*.html" -exec echo "k6 report: {}" \; >> ../services/test/performance/results/performance-summary.txt; \
	fi
	@cd test && if [ -d artillery/results ]; then \
		echo "\n=== Artillery Test Results ===" >> ../services/test/performance/results/performance-summary.txt; \
		find artillery/results -name "*.html" -exec echo "Artillery report: {}" \; >> ../services/test/performance/results/performance-summary.txt; \
	fi
	@echo "📋 Performance summary saved to services/test/performance/results/performance-summary.txt"

# Clean performance test artifacts
perf-clean:
	@echo "🧹 Cleaning performance test artifacts..."
	@rm -rf test/k6/results/*
	@rm -rf test/artillery/results/*
	@rm -rf services/test/performance/results/*
	@rm -f test/.env.perf
	@echo "✅ Performance test artifacts cleaned"

# Performance test CI targets
perf-ci-quick:
	@echo "⚡ Running quick performance tests for CI..."
	@$(MAKE) benchmark-test
	@cd test && timeout 5m k6 run --duration 2m --vus 10 k6/load-test.js || echo "k6 test completed"
	@echo "✅ Quick performance tests completed"

perf-ci-full:
	@echo "🎯 Running full performance tests for CI..."
	@$(MAKE) perf-test
	@$(MAKE) stress-test
	@echo "✅ Full CI performance tests completed"

# Individual endpoint testing
perf-test-gettopshorts:
	@echo "📊 Testing GetTopShorts endpoint..."
	@cd services && go test ./test/performance/load_test.go -v -run TestGetTopShortsLoadTest

perf-test-getstock:
	@echo "🏢 Testing GetStock endpoint..."
	@cd services && go test ./test/performance/load_test.go -v -run TestGetStockLoadTest

perf-test-getstockdata:
	@echo "📈 Testing GetStockData endpoint..."
	@cd services && go test ./test/performance/load_test.go -v -run TestGetStockDataLoadTest

perf-test-gettreemap:
	@echo "🌳 Testing GetIndustryTreeMap endpoint..."
	@cd services && go test ./test/performance/load_test.go -v -run TestGetIndustryTreeMapLoadTest

# Help target for performance testing
perf-help:
	@echo "🔧 Performance Testing Commands:"
	@echo "  perf-go-tests    - Run Go performance tests (testcontainers, self-contained)"
	@echo "  perf-install     - Install performance testing tools"
	@echo "  perf-setup       - Setup performance test environment"
	@echo "  perf-test        - Run standard performance tests"
	@echo "  load-test        - Run comprehensive load testing"
	@echo "  stress-test      - Run stress tests with k6"
	@echo "  spike-test       - Run spike tests with k6"
	@echo "  benchmark-test   - Run Go benchmark tests"
	@echo "  perf-all         - Run ALL performance tests"
	@echo "  perf-baseline    - Validate against performance baseline"
	@echo "  perf-report      - Generate performance reports"
	@echo "  perf-clean       - Clean performance test artifacts"
	@echo ""
	@echo "📊 Specialized Tests:"
	@echo "  perf-concurrent  - Test concurrent user scenarios"
	@echo "  perf-db-pool     - Test database connection pool"
	@echo "  perf-sustained   - Run 15-minute sustained load test"
	@echo "  perf-cache       - Test cache effectiveness"
	@echo "  perf-memory      - Test memory usage patterns"
	@echo ""
	@echo "🎯 Individual Endpoints:"
	@echo "  perf-test-gettopshorts  - Test GetTopShorts only"
	@echo "  perf-test-getstock      - Test GetStock only"
	@echo "  perf-test-getstockdata  - Test GetStockData only"
	@echo "  perf-test-gettreemap    - Test GetIndustryTreeMap only"
	@echo ""
	@echo "💡 Note: Go performance tests (perf-go-tests) are self-contained and don't require perf-install"
