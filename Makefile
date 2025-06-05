# Shorted.com.au Root Makefile
# Orchestrates testing and building for both frontend and backend

.PHONY: help test test-frontend test-backend test-coverage test-watch test-integration test-stack-up test-stack-down install clean build dev dev-script dev-frontend dev-backend lint format populate-data populate-data-quick

# Default target
help:
	@echo "Available commands:"
	@echo "  test          - Run all tests (frontend + backend)"
	@echo "  test-frontend - Run frontend tests only"
	@echo "  test-backend  - Run backend tests only"
	@echo "  test-coverage - Run all tests with coverage reporting"
	@echo "  test-watch    - Run frontend tests in watch mode"
	@echo "  test-integration - Run full-stack integration tests"
	@echo "  test-stack-up - Start test environment"
	@echo "  test-stack-down - Stop test environment"
	@echo "  install       - Install all dependencies"
	@echo "  clean         - Clean all build artifacts"
	@echo "  build         - Build frontend and backend"
	@echo "  dev           - Start database, backend and frontend dev servers"
	@echo "  dev-db        - Start PostgreSQL database only"
	@echo "  dev-frontend  - Start frontend dev server only"
	@echo "  dev-backend   - Start backend dev server only"
	@echo "  dev-stop      - Stop all development services"
	@echo "  lint          - Run linting for all projects"
	@echo "  format        - Format code for all projects"
	@echo "  populate-data - Download and populate database with ASIC short selling data"
	@echo "  populate-data-quick - Populate database using existing CSV files (no download)"

# Test commands
test: test-frontend test-backend

test-frontend:
	@echo "🧪 Running frontend tests..."
	@cd web && npm test

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
	@cd web && rm -rf .next node_modules/.cache coverage/

clean-backend:
	@echo "🧹 Cleaning backend build artifacts..."
	@cd services && go clean -cache -testcache && rm -f coverage.out coverage.html

# Build commands
build: build-frontend

build-frontend:
	@echo "🏗️  Building frontend..."
	@cd web && npm run build

build-backend:
	@echo "🏗️  Building backend..."
	@cd services && make build.shorts

# Development commands
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

dev-stop-services: ## Stop only application services (not database)
	@echo "🛑 Stopping application services..."
	@pkill -f "next dev" 2>/dev/null || true
	@pkill -f "go run" 2>/dev/null || true
	@lsof -ti:3020 | xargs kill -9 2>/dev/null || true
	@lsof -ti:9091 | xargs kill -9 2>/dev/null || true
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

# Linting commands
lint: lint-frontend lint-backend

lint-frontend:
	@echo "🔍 Linting frontend..."
	@cd web && npm run lint

lint-backend:
	@echo "🔍 Linting backend..."
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

pre-commit: format lint test
	@echo "✅ Pre-commit checks passed"

# Service-specific shortcuts
test-shorts:
	@echo "🧪 Running shorts service tests..."
	@cd services && make test.shorts

# Integration testing commands
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