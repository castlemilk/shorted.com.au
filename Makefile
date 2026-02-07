# Shorted.com.au Root Makefile
# Orchestrates testing and building for both frontend and backend

.PHONY: help run test test-frontend test-backend test-coverage test-watch test-integration test-e2e test-e2e-ui test-e2e-headed test-stack-up test-stack-down install install-hooks clean clean-cache clean-all clean-ports build dev dev-clean dev-script dev-frontend dev-backend lint format populate-data populate-data-quick backfill-websites backfill-websites-dry db-diagnose db-optimize db-analyze algolia-sync algolia-sync-prod algolia-search enrich-metadata enrich-metadata-all enrich-metadata-stocks pipeline-local pipeline-prod pipeline-daily pipeline-help

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



# Default target
help:
	@echo "Available commands:"
	@echo "  run              - Start all services for local development (alias for dev)"
	@echo "  dev              - Start database, backend and frontend dev servers"
	@echo "  dev-db           - Start PostgreSQL database only"
	@echo "  dev-frontend     - Start frontend dev server only"
	@echo "  dev-backend      - Start backend dev server only (shorts service)"
	@echo "  dev-market-data  - Start market data service only (port 8090)"
	@echo "  dev-stripe       - Start Stripe CLI webhook forwarding (for local payment testing)"
	@echo "  dev-stop         - Stop all development services"
	@echo "  install       - Install all dependencies"
	@echo "  install-hooks - Install git hooks for pre-commit testing"
	@echo "  clean         - Clean all build artifacts"
	@echo "  clean-cache   - Clear Next.js caches (fixes 'Element type is invalid' errors)"
	@echo "  clean-all     - Clean build artifacts AND caches"
	@echo "  clean-ports   - Kill any stale processes on development ports (9091, 3000, 5432)"
	@echo "  build         - Build frontend and backend"
	@echo "  test          - Run complete pre-push validation (lint + build + unit + integration)"
	@echo "  test-unit     - Run unit tests only (frontend + backend)"
	@echo "  test-frontend - Run frontend tests only"
	@echo "  test-backend  - Run backend tests only"
	@echo "  test-coverage - Run all tests with coverage reporting"
	@echo "  test-watch    - Run frontend tests in watch mode"
	@echo "  test-integration-local - Run integration tests with local backend (self-contained)"
	@echo "  test-integration - Run full-stack integration tests"
	@echo "  test-e2e      - Run E2E tests with all dependencies"
	@echo "  test-e2e-ui   - Run E2E tests in Playwright UI mode"
	@echo "  test-stack-up - Start test environment"
	@echo "  test-stack-down - Stop test environment"
	@echo "  lint          - Run linting (TypeScript + golangci-lint)"
	@echo "  lint-frontend - Run TypeScript/ESLint linting"
	@echo "  lint-backend  - Run golangci-lint for Go code"
	@echo "  format        - Format code for all projects"
	@echo "  populate-data - Download and populate database with ASIC short selling data"
	@echo "  populate-data-quick - Populate database using existing CSV files (no download)"
	@echo "  backfill-websites - Backfill company website URLs from metadata CSV"
	@echo "  db-diagnose   - Diagnose database query performance issues"
	@echo "  db-optimize   - Apply performance indexes to database"
	@echo "  db-analyze    - Update database statistics for query optimizer"
	@echo "  backfill-historical - Backfill historical stock data (all stocks, 10 years)"
	@echo "  backfill-historical-symbol - Backfill for specific stock (usage: SYMBOL=DMP)"
	@echo "  backfill-historical-test - Test backfill with limited stocks (usage: LIMIT=10 YEARS=2)"

# Test commands
test: lint build-frontend test-unit
	@if docker info > /dev/null 2>&1; then \
		echo "🐳 Docker available - running integration tests..."; \
		$(MAKE) test-integration-local; \
		echo ""; \
		echo "✅ All tests, linting, and build validation completed successfully!"; \
		echo "   🔍 Linting: TypeScript + Go"; \
		echo "   🏗️  Build: Frontend (type checking)"; \
		echo "   🧪 Unit Tests: Frontend + Backend"; \
		echo "   🔗 Integration Tests: Backend"; \
	else \
		echo ""; \
		echo "⚠️  Docker not available - skipping integration tests"; \
		echo "   Start Docker Desktop to run integration tests"; \
		echo ""; \
		echo "✅ Lint, build, and unit tests completed successfully!"; \
		echo "   🔍 Linting: TypeScript + Go"; \
		echo "   🏗️  Build: Frontend (type checking)"; \
		echo "   🧪 Unit Tests: Frontend + Backend"; \
	fi
	@echo ""

# Unit tests only (no linting, no integration)
test-unit: test-frontend test-backend

test-frontend:
	@echo "🧪 Running frontend tests..."
	@cd web && npm test -- --watchAll=false --testPathIgnorePatterns=integration

test-backend:
	@echo "🧪 Running backend tests..."
	@cd services && make test

test-coverage: test-frontend-coverage test-backend-coverage

test-frontend-coverage:
	@echo "📊 Running frontend tests with coverage..."
	@cd web && npm run test:coverage

test-backend-coverage:
	@echo "📊 Running backend tests with coverage..."
	@cd services && make test.coverage

test-watch:
	@echo "👀 Running frontend tests in watch mode..."
	@cd web && npm run test:watch

# Installation commands
install: install-frontend install-backend

install-frontend:
	@echo "📦 Installing frontend dependencies..."
	@cd web && npm install

install-backend:
	@echo "📦 Installing backend dependencies..."
	@cd services && go mod download && go mod tidy

install-hooks: ## Install git hooks for pre-commit testing
	@echo "🔧 Installing git hooks..."
	@bash scripts/install-hooks.sh

# Clean commands
clean: clean-frontend clean-backend

clean-frontend:
	@echo "🧹 Cleaning frontend build artifacts..."
	@cd web && rm -rf .next out coverage/

clean-backend:
	@echo "🧹 Cleaning backend build artifacts..."
	@cd services && go clean -cache -testcache && rm -f coverage.out coverage.html

clean-cache: ## Clear Next.js and webpack caches (fixes "Element type is invalid" errors)
	@echo "🧹 Clearing Next.js and webpack caches..."
	@cd web && rm -rf .next node_modules/.cache
	@echo "✅ Caches cleared - restart dev server with 'make dev'"

clean-all: clean clean-cache ## Clean all build artifacts and caches
	@echo "✅ All build artifacts and caches cleared"

clean-ports:
	@echo "🧹 Killing stale processes on development ports..."
	@$(call kill_pids_in_project_by_port,9091,-9)
	@$(call kill_pids_in_project_by_port,3000,-9)
	@$(call kill_pids_in_project_by_port,8090,-9)
	@echo "✅ Ports cleaned (9091, 3000, 8090)"

# Build commands
build: build-frontend

build-frontend:
	@echo "🏗️  Building frontend..."
	@cd web && npm run build

build-backend:
	@echo "🏗️  Building backend..."
	@cd services && make build.shorts

# Development commands
run: dev ## Start all services for local development (alias for dev)

dev: dev-stop-services dev-db ## Start database, backend and frontend development servers
	@if [ -f package.json ] && command -v npm >/dev/null 2>&1; then \
		echo "🚀 Starting full application with npm concurrently..."; \
		npm run dev; \
	else \
		echo "🚀 Starting full application..."; \
		echo "Frontend: http://localhost:3020"; \
		echo "Backend: http://localhost:9091"; \
		echo "Database: localhost:5438"; \
		echo ""; \
		echo "Press Ctrl+C to stop all services"; \
		echo "────────────────────────────────────────"; \
		make -j 2 dev-frontend dev-backend; \
	fi

dev-db: ## Start the PostgreSQL database for development
	@echo "🗄️  Starting PostgreSQL database..."
	@cd analysis/sql && docker compose up -d postgres
	@echo "⏳ Waiting for database to be ready..."
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if (cd analysis/sql && docker compose exec -T postgres pg_isready -U admin -d shorts > /dev/null 2>&1); then \
			echo "✅ Database is ready"; \
			exit 0; \
		fi; \
		echo "Attempt $$i/10: Database not ready yet, waiting..."; \
		sleep 3; \
	done; \
	echo "⚠️  Database may not be ready after 30 seconds"; \
	exit 1;

dev-script: ## Start development using the shell script
	@./scripts/dev.sh

dev-frontend:
	@echo "🚀 Starting frontend development server..."
	@cd web && npm run dev

dev-backend:
	@echo "🚀 Starting backend development server..."
	@cd services && make run.shorts

dev-market-data:
	@echo "🚀 Starting market data service..."
	@cd services && make run.market-data

dev-enrichment-processor:
	@echo "🚀 Starting enrichment processor..."
	@cd services && make run.enrichment-processor

dev-stripe: ## Start Stripe CLI webhook forwarding
	@echo "💳 Starting Stripe CLI webhook forwarding..."
	@if ! command -v stripe >/dev/null 2>&1; then \
		echo "❌ Stripe CLI not installed."; \
		echo "   Install with: brew install stripe/stripe-cli/stripe"; \
		echo "   Or download from: https://stripe.com/docs/stripe-cli"; \
		exit 1; \
	fi
	@echo "Forwarding webhooks to http://localhost:3020/api/stripe/webhook"
	@echo "Use the webhook signing secret shown below in your .env.local"
	@echo "────────────────────────────────────────"
	@stripe listen --forward-to localhost:3020/api/stripe/webhook

dev-stop-services: ## Stop only application services (not database) - scoped to this project
	@echo "🛑 Stopping application services..."
	@PROJECT_DIR="$(CURDIR)"; \
	echo "Stopping frontend service (port 3020) for $$PROJECT_DIR..."; \
	for pid in $$(lsof -ti:3020 2>/dev/null); do \
		if ps -p $$pid -o args= 2>/dev/null | grep -q "$$PROJECT_DIR"; then \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done; \
	echo "Stopping backend service (port 9091) for $$PROJECT_DIR..."; \
	for pid in $$(lsof -ti:9091 2>/dev/null); do \
		if ps -p $$pid -o args= 2>/dev/null | grep -q "$$PROJECT_DIR"; then \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done; \
	echo "Stopping market data service (port 8090) for $$PROJECT_DIR..."; \
	for pid in $$(lsof -ti:8090 2>/dev/null); do \
		if ps -p $$pid -o args= 2>/dev/null | grep -q "$$PROJECT_DIR"; then \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done; \
	echo "Stopping enrichment processor for $$PROJECT_DIR..."; \
	for pid in $$(pgrep -f "$$PROJECT_DIR.*enrichment-processor" 2>/dev/null); do \
		pkill -P $$pid 2>/dev/null || true; \
		kill -9 $$pid 2>/dev/null || true; \
	done; \
	echo "Stopping Stripe CLI for $$PROJECT_DIR..."; \
	pkill -f "stripe listen.*3020" 2>/dev/null || true
	@echo "✅ Application services stopped"

dev-stop: ## Stop all development services
	@echo "🛑 Stopping all development services..."
	@cd analysis/sql && docker compose down
	@make dev-stop-services

dev-clean: ## Force clean all development processes (use if dev-stop didn't work) - scoped to this project
	@echo "🧹 Force cleaning all development processes for $(CURDIR)..."
	@make dev-stop-services
	@echo "Killing any remaining concurrently processes..."
	@pkill -f "$(CURDIR).*concurrently" 2>/dev/null || true
	@echo "Killing any remaining npm processes..."
	@pkill -f "$(CURDIR).*npm run dev" 2>/dev/null || true
	@echo "✅ Force cleanup complete"

populate-data: dev-db ## Download and populate database with ASIC short selling data
	@echo "📊 Populating database with short selling data..."
	@cd services && make populate-data

populate-data-quick: dev-db ## Populate database using existing CSV files (no download)
	@echo "📊 Quick populating database from existing files..."
	@cd services && make populate-data-quick

backfill-websites: dev-db ## Backfill company website URLs from metadata CSV
	@echo "🌐 Backfilling company websites from metadata CSV..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	python3 scripts/backfill-websites.py

backfill-websites-dry: dev-db ## Preview website backfill without making changes
	@echo "🌐 [DRY RUN] Previewing website backfill..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	python3 scripts/backfill-websites.py --dry-run

populate-stock-data: dev-db ## Populate database with historical stock price data
	@echo "📊 Populating database with historical stock price data..."
	@cd services/stock-price-ingestion && python populate_historical_data.py

populate-stock-data-full: dev-db ## Populate database with full historical stock data (5 years)
	@echo "📊 Populating database with 5 years of stock price data..."
	@cd services/stock-price-ingestion && python populate_historical_data.py --start-date $$(date -d "5 years ago" +%Y-%m-%d)

populate-stock-data-custom: dev-db ## Populate with custom stocks and date range
	@echo "📊 Usage: make populate-stock-data-custom STOCKS=CBA,BHP,CSL START=2022-01-01 END=2024-01-01"
	@cd services/stock-price-ingestion && python populate_historical_data.py --stocks $(STOCKS) --start-date $(START) --end-date $(END)

repair-gaps: dev-db ## Detect and repair historical data gaps (usage: make repair-gaps STOCKS=CBA,BHP)
	@echo "🛠️ Repairing historical data gaps..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	if [ -n "$(STOCKS)" ]; then \
		python3 scripts/repair-gaps.py --stocks $(STOCKS); \
	else \
		python3 scripts/repair-gaps.py; \
	fi

repair-gaps-all: dev-db ## Batch repair ALL stocks with insufficient data (< 2000 records)
	@echo "🛠️ Starting batch repair of all stocks with gaps..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	python3 scripts/repair-gaps.py --repair-all $(if $(LIMIT),--limit $(LIMIT),) $(if $(DRY_RUN),--dry-run,)

repair-gaps-dry-run: dev-db ## Show which stocks would be repaired (no changes made)
	@echo "🔍 Checking which stocks need repair..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	python3 scripts/repair-gaps.py --repair-all --dry-run

repair-gaps-status: dev-db ## Show repair status summary
	@echo "📊 Checking historical data status..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	psql $$DATABASE_URL -c " \
		SELECT \
			COUNT(*) as total_stocks, \
			COUNT(CASE WHEN records < 500 THEN 1 END) as needs_backfill, \
			COUNT(CASE WHEN records >= 500 AND records < 2000 THEN 1 END) as partial_data, \
			COUNT(CASE WHEN records >= 2000 THEN 1 END) as complete \
		FROM (SELECT stock_code, COUNT(*) as records FROM stock_prices GROUP BY stock_code) sub;"

# Daily sync commands
daily-sync-local: ## Run daily sync locally (updates shorts + stock prices)
	@echo "🔄 Running daily sync locally..."
	@if [ -z "$$DATABASE_URL" ]; then \
		export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"; \
	fi; \
	cd services/daily-sync && python3 comprehensive_daily_sync.py

daily-sync-deploy: ## Deploy daily sync job to Cloud Run (scheduled for 2 AM AEST)
	@echo "☁️  Deploying daily sync to Cloud Run..."
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "❌ DATABASE_URL environment variable is required"; \
		echo "   Usage: export DATABASE_URL='postgresql://...'"; \
		exit 1; \
	fi
	@cd services/daily-sync && chmod +x deploy.sh && ./deploy.sh

daily-sync-execute: ## Execute daily sync job now (Cloud Run)
	@echo "🚀 Executing daily sync job..."
	@gcloud run jobs execute comprehensive-daily-sync \
		--region asia-northeast1 \
		--project shorted-dev-aba5688f

daily-sync-logs: ## View daily sync job logs
	@echo "📋 Viewing daily sync logs..."
	@gcloud logging read \
		"resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
		--limit 100 \
		--project shorted-dev-aba5688f \
		--format="table(timestamp, severity, textPayload)"

daily-sync-status: ## Check daily sync scheduler status
	@echo "⏰ Checking scheduler status..."
	@gcloud scheduler jobs describe comprehensive-daily-sync-trigger \
		--location asia-northeast1 \
		--project shorted-dev-aba5688f

daily-sync-test: ## Run e2e tests for daily sync
	@echo "🧪 Running daily sync integration tests..."
	@cd services/daily-sync && ./test_integration.sh

daily-sync-test-quick: ## Run quick tests (no external API calls)
	@echo "🧪 Running quick tests..."
	@cd services/daily-sync && python3 -m pytest test_daily_sync.py::TestDatabaseConnectivity -v

demo-stock-data: ## Demo: Test stock data fetching with progress bar (no database required)
	@echo "📊 Running stock data fetching demo..."
	@cd services/stock-price-ingestion && source venv/bin/activate && python demo_populate.py

demo-stock-data-custom: ## Demo: Test custom stocks and date range
	@echo "📊 Usage: make demo-stock-data-custom STOCKS=CBA,BHP,CSL START=2025-07-01"
	@cd services/stock-price-ingestion && source venv/bin/activate && python demo_populate.py --stocks $(STOCKS) --start-date $(START)

# Linting commands
lint: lint-frontend lint-backend

lint-frontend:
	@echo "🔍 Linting frontend..."
	@cd web && npm run lint -- --max-warnings 1000

lint-backend: lint-backend-install
	@echo "🔍 Linting backend with golangci-lint..."
	@cd services && golangci-lint run ./...

lint-backend-install:
	@which golangci-lint > /dev/null || { \
		echo "📦 Installing golangci-lint..."; \
		if [ "$$(uname)" = "Darwin" ]; then \
			brew install golangci-lint; \
		else \
			curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $$(go env GOPATH)/bin v1.61.0; \
		fi; \
	}

lint-backend-quick:
	@echo "🔍 Quick linting backend (go vet + go fmt)..."
	@cd services && go vet ./... && go fmt ./...

# Format commands
format: format-frontend format-backend

format-frontend:
	@echo "✨ Formatting frontend code..."
	@cd web && npx prettier --write .

format-backend:
	@echo "✨ Formatting backend code..."
	@cd services && go fmt ./...

# CI/CD helpful commands
ci-test: install test-coverage lint
	@echo "✅ CI tests completed successfully"

# Secrets validation
validate-secrets: ## Validate environment secrets for deployment
	@./scripts/validate-secrets.sh $(ENV)

validate-secrets-preview: ## Validate secrets for preview environment
	@./scripts/validate-secrets.sh preview

validate-secrets-dev: ## Validate secrets for dev environment
	@./scripts/validate-secrets.sh dev

validate-secrets-prod: ## Validate secrets for production environment
	@./scripts/validate-secrets.sh prod

pre-commit: test
	@echo "✅ Pre-commit checks passed - ready to push!"

pre-push: test
	@echo "✅ Pre-push validation complete - all tests passed!"

# Service-specific shortcuts
test-shorts:
	@echo "🧪 Running shorts service tests..."
	@cd services && make test.shorts

# Validation commands
test-validation: test-backend-validation test-data-validation
	@echo "✅ All validation tests completed"

test-backend-validation:
	@echo "🧪 Running backend validation tests..."
	@cd services && go test -v ./shorts/internal/services/shorts -run TestValidate
	@cd services && go test -v ./market-data -run TestValidate

test-data-validation:
	@echo "🧪 Running data validation tests..."
	@cd services/stock-price-ingestion && python -m pytest test_data_validation.py -v

# Integration testing commands
test-integration-local:
	@echo "🧪 Running integration tests with local backend..."
	@cd services && make test-integration-local

test-integration: test-stack-up
	@echo "🧪 Running full-stack integration tests..."
	@sleep 15  # Give services time to start and be ready
	@cd test/integration && go mod download && go test -v ./...
	@make test-stack-down

test-e2e: test-stack-up
	@echo "🎭 Running Playwright E2E tests..."
	@sleep 15  # Give services time to start
	@cd web && npm run test:e2e
	@make test-stack-down

test-e2e-ui: test-stack-up
	@echo "🎭 Running Playwright E2E tests with UI..."
	@sleep 15
	@cd web && npm run test:e2e:ui
	@make test-stack-down

test-all-integration: test-integration test-e2e
	@echo "✅ All integration tests completed"

test-stack-up:
	@echo "🚀 Starting test environment..."
	@cd test/integration && docker compose -f docker-compose.test.yml up -d
	@echo "⏳ Waiting for services to be ready..."
	@echo "Waiting for database to be ready..."
	@timeout 60 bash -c 'until docker exec $$(docker compose -f test/integration/docker-compose.test.yml ps -q postgres-test) pg_isready -U test_user; do sleep 2; done' || echo "Database may not be ready"
	@echo "Waiting for backend service to be ready..."
	@echo "Waiting for backend service to be ready..."
	@BACKEND_PORT=$$(docker port $$(docker compose -f test/integration/docker-compose.test.yml ps -q shorts-service-test) 8080/tcp 2>/dev/null | cut -d: -f2); \
		if [ -n "$$BACKEND_PORT" ]; then \
			timeout 60 bash -c "until curl -f http://localhost:$$BACKEND_PORT/health > /dev/null 2>&1; do sleep 2; done" || echo "Backend may not be ready"; \
		fi
	@echo "Waiting for frontend service to be ready..."
	@FRONTEND_PORT=$$(docker port $$(docker compose -f test/integration/docker-compose.test.yml ps -q web-test) 3000/tcp 2>/dev/null | cut -d: -f2); \
		if [ -n "$$FRONTEND_PORT" ]; then \
			timeout 60 bash -c "until curl -f http://localhost:$$FRONTEND_PORT/api/health > /dev/null 2>&1; do sleep 2; done" || echo "Frontend may not be ready"; \
		fi
	@echo "✅ Test environment is ready"

test-stack-down:
	@echo "🛑 Stopping test environment..."
	@cd test/integration && docker compose -f docker-compose.test.yml down -v
	@echo "🧹 Cleaning up test containers..."
	@docker system prune -f --filter "label=com.docker.compose.project=integration"

test-stack-logs:
	@echo "📋 Showing test environment logs..."
	@cd test/integration && docker compose -f docker-compose.test.yml logs

test-stack-status:
	@echo "📊 Test environment status..."
	@cd test/integration && docker compose -f docker-compose.test.yml ps

# Quick development setup
setup: install
	@echo "🎉 Project setup completed!"
	@echo ""
	@echo "To get started:"
	@echo "  make dev           # Start both frontend and backend"
	@echo "  make dev-frontend  # Start frontend dev server only"
	@echo "  make dev-backend   # Start backend dev server only"
	@echo "  make test          # Run all tests"

# Database and infrastructure
db-reset:
	@echo "🗄️  Resetting database..."
	@echo "Note: This should connect to your database reset script"
	# Add your database reset commands here

db-diagnose: ## Diagnose database query performance issues
	@echo "🔍 Diagnosing database performance..."
	@python3 scripts/diagnose-slow-queries.py

db-optimize: ## Apply performance indexes to database
	@echo "⚡ Applying performance indexes..."
	@python3 scripts/apply-performance-indexes.py
	@echo "✅ Performance indexes applied successfully"
	@echo "Run 'make db-diagnose' to verify improvements"

db-analyze: ## Update database statistics for query planner
	@echo "📊 Updating database statistics..."
	@echo "This requires DATABASE_URL environment variable to be set"
	@echo "Run: ANALYZE shorts; ANALYZE \"company-metadata\";"

# Historical Backfill Commands
backfill-historical: ## Backfill historical stock data for all stocks (10 years)
	@cd services && $(MAKE) backfill.historical

backfill-historical-symbol: ## Backfill historical data for a specific stock (usage: make backfill-historical-symbol SYMBOL=DMP)
	@cd services && $(MAKE) backfill.historical-symbol SYMBOL=$(SYMBOL)

backfill-historical-force: ## Force re-fetch all historical data (ignores existing records)
	@cd services && $(MAKE) backfill.historical-force

backfill-historical-test: ## Test backfill with limited stocks (usage: make backfill-historical-test LIMIT=10 YEARS=2)
	@cd services && $(MAKE) backfill.historical-test LIMIT=$(LIMIT) YEARS=$(YEARS)

db-optimize-full: ## Full database optimization (indexes + statistics + validation)
	@echo "🚀 Running full database optimization..."
	@echo "📦 Checking Python dependencies..."
	@python3 -c "import asyncpg" 2>/dev/null || { \
		echo "⚠️  asyncpg not found. Installing..."; \
		pip install -q asyncpg || { \
			echo "❌ Failed to install asyncpg. Please run: pip install asyncpg"; \
			exit 1; \
		}; \
	}
	@if [ -z "$$DATABASE_URL" ] && [ -z "$$SUPABASE_DB_URL" ]; then \
		echo "❌ DATABASE_URL or SUPABASE_DB_URL environment variable is required"; \
		echo "   Example: export DATABASE_URL='postgresql://user:pass@host:port/db'"; \
		exit 1; \
	fi
	@python3 scripts/optimize-database.py

# Health checks
health-check:
	@echo "🩺 Running health checks..."
	@echo "Checking frontend dependencies..."
	@cd web && npm ls --depth=0 > /dev/null || echo "❌ Frontend dependency issues found"
	@echo "Checking backend module..."
	@cd services && go mod verify > /dev/null || echo "❌ Backend module issues found"
	@echo "✅ Health check completed"

# Generate API docs
docs:
	@echo "📚 Generating API documentation..."
	@cd services && make generate.statik

# Show test results summary
test-summary: test-coverage
	@echo ""
	@echo "📋 Test Summary:"
	@echo "Frontend coverage: See web/coverage/index.html"
	@echo "Backend coverage: See services/coverage.html"

# =========================================
# Search Index Management (Algolia)
# =========================================

algolia-sync: ## Sync Algolia search index with local database
	@echo "🔄 Syncing Algolia index with local database..."
	@cd web && make algolia.sync

algolia-sync-prod: ## Sync Algolia search index with production database
	@if [ -z "$$DATABASE_URL" ]; then echo "❌ DATABASE_URL required"; exit 1; fi
	@echo "🔄 Syncing Algolia index with production database..."
	@cd web && DATABASE_URL=$$DATABASE_URL make algolia.sync.prod

algolia-search: ## Test Algolia search (usage: make algolia-search Q=BHP)
	@cd web && make algolia.search Q=$(Q)

# =========================================
# Company Metadata Pipeline
# =========================================

enrich-metadata: ## Enrich company metadata using GPT-4 (usage: make enrich-metadata LIMIT=10)
	@echo "🧠 Enriching company metadata..."
	@cd analysis && python enrich_database.py --limit $(or $(LIMIT),10)

enrich-metadata-all: ## Enrich ALL company metadata (expensive - uses GPT-4)
	@echo "⚠️  This will enrich ALL companies using GPT-4 API calls"
	@read -p "Are you sure? Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || exit 1
	@cd analysis && python enrich_database.py --all

enrich-metadata-stocks: ## Enrich specific stocks (usage: make enrich-metadata-stocks STOCKS="CBA BHP")
	@if [ -z "$(STOCKS)" ]; then echo "Usage: make enrich-metadata-stocks STOCKS='CBA BHP WBC'"; exit 1; fi
	@echo "🧠 Enriching metadata for: $(STOCKS)..."
	@cd analysis && python enrich_database.py --stocks $(STOCKS)

enrich-api: ## Enrich via preview API (usage: make enrich-api STOCKS="CBA BHP" or make enrich-api BATCH=10)
	@if [ -n "$(STOCKS)" ]; then \
		echo "🧠 Enriching via API: $(STOCKS)..."; \
		python3 scripts/enrich_via_api.py --stocks $(STOCKS) $(if $(FORCE),--force,); \
	elif [ -n "$(BATCH)" ]; then \
		echo "🧠 Enriching batch of $(BATCH) via API..."; \
		python3 scripts/enrich_via_api.py --batch $(BATCH) $(if $(FORCE),--force,); \
	else \
		echo "Usage: make enrich-api STOCKS='CBA BHP' or make enrich-api BATCH=10"; \
		echo "       Add FORCE=1 to force re-enrichment"; \
	fi

enrich-api-status: ## Show enrichment job status from preview API
	@echo "📊 Checking enrichment job status..."
	@python3 scripts/enrich_via_api.py --status

enrich-api-review: ## Show pending enrichments for review from preview API
	@echo "📋 Showing pending enrichments..."
	@python3 scripts/enrich_via_api.py --review

# =========================================
# Full Data Pipeline
# =========================================

pipeline-local: ## Run full pipeline locally: enrich → sync Algolia
	@echo "🚀 Running full data pipeline (local)..."
	@echo ""
	@echo "Step 1/2: Enriching company metadata..."
	@cd analysis && python enrich_database.py --limit $(or $(LIMIT),5) || true
	@echo ""
	@echo "Step 2/2: Syncing Algolia index..."
	@cd web && make algolia.sync
	@echo ""
	@echo "✅ Pipeline complete!"

pipeline-prod: ## Run full pipeline on production: enrich → sync Algolia
	@if [ -z "$$DATABASE_URL" ]; then echo "❌ DATABASE_URL required"; exit 1; fi
	@if [ -z "$$OPENAI_API_KEY" ]; then echo "❌ OPENAI_API_KEY required"; exit 1; fi
	@echo "🚀 Running full data pipeline (production)..."
	@echo ""
	@echo "Step 1/2: Enriching company metadata..."
	@cd analysis && python enrich_database.py --limit $(or $(LIMIT),10)
	@echo ""
	@echo "Step 2/2: Syncing Algolia index..."
	@cd web && DATABASE_URL=$$DATABASE_URL make algolia.sync.prod
	@echo ""
	@echo "✅ Pipeline complete!"

pipeline-daily: ## Run daily sync pipeline: ASIC data → stock prices → Algolia
	@echo "🔄 Running daily sync pipeline..."
	@echo ""
	@echo "Step 1/2: Syncing ASIC shorts + stock prices..."
	@make daily-sync-local
	@echo ""
	@echo "Step 2/2: Syncing Algolia index..."
	@cd web && make algolia.sync
	@echo ""
	@echo "✅ Daily pipeline complete!"

pipeline-help: ## Show pipeline documentation
	@echo ""
	@echo "📊 Data Pipeline Overview"
	@echo "========================="
	@echo ""
	@echo "The data pipeline has 3 main stages:"
	@echo ""
	@echo "  1. DISCOVER: Enrich company metadata"
	@echo "     - Uses GPT-4 to generate summaries"
	@echo "     - Crawls company websites for details"
	@echo "     - Fetches data from Yahoo Finance"
	@echo "     Commands: make enrich-metadata, enrich-metadata-stocks"
	@echo ""
	@echo "  2. UPDATE DB: Sync market data"
	@echo "     - Downloads ASIC short selling data"
	@echo "     - Updates stock prices from Yahoo/Alpha Vantage"
	@echo "     Commands: make daily-sync-local, populate-data"
	@echo ""
	@echo "  3. UPDATE INDEX: Sync Algolia search"
	@echo "     - Pushes company metadata to Algolia"
	@echo "     - Configures search relevance settings"
	@echo "     Commands: make algolia-sync, algolia-sync-prod"
	@echo ""
	@echo "Full Pipelines:"
	@echo "  make pipeline-local    - Run enrichment + Algolia sync locally"
	@echo "  make pipeline-prod     - Run enrichment + Algolia sync on production"
	@echo "  make pipeline-daily    - Run ASIC sync + Algolia sync (daily job)"
	@echo ""