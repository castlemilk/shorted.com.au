BASE_URL := http://localhost:9091
GOOGLE_APPLICATION_CREDENTIALS := shorted-dev-aba5688f-4a322ff163b9.json
SHORTS_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts
SHORTS_VERSION := `git describe --tags --always --dirty`
SHORTS_SYNC_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/short-data-sync
STOCK_PRICE_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/stock-price-ingestion
SHORTS_DATABASE_URL := postgresql://admin:password@postgres:5432/shorts
# IMPORTANT: Set DATABASE_URL environment variable before running commands
# export DATABASE_URL='your-database-url'
MIGRATION_PATH := file://migrations

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
	@lsof -ti:9091 | xargs kill -9 2>/dev/null || true
	@pkill -f "go run shorts/cmd/server/main.go" 2>/dev/null || true
	@sleep 1

run.shorts: clean.shorts
	GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS} go run shorts/cmd/server/main.go 
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

# Data population commands
.PHONY: build.populate-data run.populate-data populate-data populate-data-quick populate-data-force

build.populate-data:
	go build -o bin/populate-data ./cmd/populate-data

run.populate-data: build.populate-data
	./bin/populate-data

populate-data: build.populate-data
	@echo "🚀 Starting data population (downloads new files only)..."
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

# Test commands
.PHONY: test test.coverage test.shorts test.integration bench

test:
	go test ./... -v

test.coverage:
	go test ./... -v -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html

test.shorts:
	go test ./shorts/... -v

test.integration:
	go test ./... -v -tags=integration

bench:
	go test ./... -bench=. -benchmem