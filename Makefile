# Shorted.com.au Root Makefile
# Orchestrates testing and building for both frontend and backend

.PHONY: help run test test-frontend test-backend test-coverage test-watch test-integration test-e2e test-e2e-ui test-e2e-headed test-stack-up test-stack-down install clean clean-cache clean-all clean-ports build dev dev-clean dev-script dev-frontend dev-backend lint format populate-data populate-data-quick db-diagnose db-optimize db-analyze

# Default target
help:
	@echo "Available commands:"
	@echo "  run              - Start all services for local development (alias for dev)"
	@echo "  dev              - Start database, backend and frontend dev servers"
	@echo "  dev-db           - Start PostgreSQL database only"
	@echo "  dev-frontend     - Start frontend dev server only"
	@echo "  dev-backend      - Start backend dev server only (shorts service)"
	@echo "  dev-market-data  - Start market data service only (port 8090)"
	@echo "  dev-stop         - Stop all development services"
	@echo "  install       - Install all dependencies"
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
	@echo "  db-diagnose   - Diagnose database query performance issues"
	@echo "  db-optimize   - Apply performance indexes to database"
	@echo "  db-analyze    - Update database statistics for query optimizer"

# Test commands
test: lint build-frontend test-unit test-integration-local
	@echo ""
	@echo "✅ All tests, linting, and build validation completed successfully!"
	@echo "   🔍 Linting: TypeScript + Go"
	@echo "   🏗️  Build: Frontend (type checking)"
	@echo "   🧪 Unit Tests: Frontend + Backend"
	@echo "   🔗 Integration Tests: Backend"
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
	@-lsof -ti :9091 | xargs kill -9 2>/dev/null || true
	@-lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@-lsof -ti :8090 | xargs kill -9 2>/dev/null || true
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
		if docker exec shorted_db pg_isready -U admin -d shorts > /dev/null 2>&1; then \
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

dev-stop-services: ## Stop only application services (not database)
	@echo "🛑 Stopping application services..."
	@echo "Stopping frontend service on port 3020..."
	@lsof -ti:3020 | xargs kill -9 2>/dev/null || true
	@echo "Stopping backend service on port 9091..."
	@lsof -ti:9091 | xargs kill -9 2>/dev/null || true
	@echo "Stopping market data service on port 8090..."
	@lsof -ti:8090 | xargs kill -9 2>/dev/null || true
	@echo "✅ Application services stopped"

dev-stop: ## Stop all development services
	@echo "🛑 Stopping all development services..."
	@cd analysis/sql && docker compose down
	@make dev-stop-services

populate-data: dev-db ## Download and populate database with ASIC short selling data
	@echo "📊 Populating database with short selling data..."
	@cd services && make populate-data

populate-data-quick: dev-db ## Populate database using existing CSV files (no download)
	@echo "📊 Quick populating database from existing files..."
	@cd services && make populate-data-quick

populate-stock-data: dev-db ## Populate database with historical stock price data
	@echo "📊 Populating database with historical stock price data..."
	@cd services/stock-price-ingestion && python populate_historical_data.py

populate-stock-data-full: dev-db ## Populate database with full historical stock data (5 years)
	@echo "📊 Populating database with 5 years of stock price data..."
	@cd services/stock-price-ingestion && python populate_historical_data.py --start-date $$(date -d "5 years ago" +%Y-%m-%d)

populate-stock-data-custom: dev-db ## Populate with custom stocks and date range
	@echo "📊 Usage: make populate-stock-data-custom STOCKS=CBA,BHP,CSL START=2022-01-01 END=2024-01-01"
	@cd services/stock-price-ingestion && python populate_historical_data.py --stocks $(STOCKS) --start-date $(START) --end-date $(END)

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
	@cd web && npm run lint

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
	@timeout 60 bash -c 'until curl -f http://localhost:8081/health > /dev/null 2>&1; do sleep 2; done' || echo "Backend may not be ready"
	@echo "Waiting for frontend service to be ready..."
	@timeout 60 bash -c 'until curl -f http://localhost:3001/api/health > /dev/null 2>&1; do sleep 2; done' || echo "Frontend may not be ready"
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