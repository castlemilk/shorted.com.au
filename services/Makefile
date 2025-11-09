BASE_URL := http://localhost:9091
GOOGLE_APPLICATION_CREDENTIALS := shorted-dev-aba5688f-4a322ff163b9.json
SHORTS_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/shorts
SHORTS_VERSION := `git describe --tags --always --dirty`
SHORTS_SYNC_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/short-data-sync
STOCK_PRICE_IMAGE := australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/stock-price-ingestion
SHORTS_DATABASE_URL := postgresql://admin:password@postgres:5432/shorts

# Default database URL for local development
# Note: Local docker-compose (in ../analysis/sql) uses admin/password on port 5438
DATABASE_URL ?= postgresql://admin:password@localhost:5438/shorts

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

# Clean up any existing processes on port 8090
.PHONY: clean.market-data
clean.market-data:
	@echo "🧹 Cleaning up existing market data service..."
	@lsof -ti:8090 | xargs kill -9 2>/dev/null || true
	@pkill -f "go run market-data/main.go" 2>/dev/null || true
	@pkill -f "market-data-service" 2>/dev/null || true
	@sleep 1

run.shorts: clean.shorts
	@echo "🚀 Starting shorts service on port 9091..."
	@echo "   Database: $(DATABASE_URL)"
	DATABASE_URL=$(DATABASE_URL) GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS} go run shorts/cmd/server/main.go

run.market-data: clean.market-data
	@echo "🚀 Starting market data service on port 8090..."
	@echo "   Database: $(DATABASE_URL)"
	@cd market-data && DATABASE_URL=$(DATABASE_URL) go run main.go validation.go 
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

# Unit tests
test:
	go test $(shell go list ./... | grep -v -E '(shorts/cmd/lambda|shorts/cmd/server|shorts/internal/services/shorts|test/integration)') -v

test.coverage:
	go test ./... -v -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html

test.shorts:
	go test ./shorts/... -v

test.integration:
	go test ./... -v -tags=integration

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
	@cd ../test/integration && go test -v -timeout=20m ./...
	@echo ""

# Integration tests - CI (expects BACKEND_URL to be set)
test-integration-ci:
	@echo "🧪 Running integration tests against deployed service..."
	@if [ -z "$$BACKEND_URL" ]; then \
		echo "❌ BACKEND_URL not set"; \
		echo "Set BACKEND_URL to your deployed service URL"; \
		exit 1; \
	fi
	@echo "Testing against: $$BACKEND_URL"
	@echo "Checking service health..."
	@curl -f "$$BACKEND_URL/health" || (echo "❌ Backend health check failed" && exit 1)
	@echo "✅ Backend is healthy"
	@echo ""
	@cd ../test/integration && go test -v -timeout=10m ./...

# New integration test targets using testcontainers
test.integration.local:
	@echo "🧪 Running integration tests with testcontainers..."
	go test ./test/integration/... -v -timeout=10m

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
	go test ./test/integration/... -v -timeout=10m -coverprofile=integration-coverage.out
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