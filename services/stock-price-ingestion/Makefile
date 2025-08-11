# Makefile for Stock Price Ingestion Service

.PHONY: help build test deploy run-local clean

# Variables
PROJECT_ID ?= shorted-prod
REGION ?= australia-southeast1
SERVICE_NAME = stock-price-ingestion
IMAGE_NAME = gcr.io/$(PROJECT_ID)/$(SERVICE_NAME)
PORT ?= 8080

help: ## Show this help message
	@echo "Stock Price Ingestion Service - Make Commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install Python dependencies
	pip install -r requirements.txt

build: ## Build Docker image locally
	docker build -t $(IMAGE_NAME):latest .

test: ## Run tests
	pytest tests/ -v

run-local: ## Run service locally with Docker
	docker run -p $(PORT):8080 \
		-e DATABASE_URL="$$DATABASE_URL" \
		-e ENVIRONMENT=development \
		$(IMAGE_NAME):latest

run-dev: ## Run service in development mode (no Docker)
	DATABASE_URL="$$DATABASE_URL" \
	ENVIRONMENT=development \
	python cloud_run_service.py

deploy: ## Deploy to Cloud Run
	./deploy.sh

deploy-staging: ## Deploy to staging environment
	GCP_PROJECT=shorted-staging \
	ENVIRONMENT=staging \
	./deploy.sh

logs: ## View Cloud Run logs
	gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$(SERVICE_NAME)" \
		--project=$(PROJECT_ID) \
		--limit=50 \
		--format=json | jq -r '.[] | "\(.timestamp) [\(.severity)] \(.textPayload // .jsonPayload.message)"'

trigger-sync: ## Manually trigger a sync
	$(eval SERVICE_URL := $(shell gcloud run services describe $(SERVICE_NAME) --region=$(REGION) --format='value(status.url)'))
	curl -X POST $(SERVICE_URL)/sync-all \
		-H "Content-Type: application/json" \
		-d '{}'

trigger-backfill: ## Trigger a backfill for last 30 days
	$(eval SERVICE_URL := $(shell gcloud run services describe $(SERVICE_NAME) --region=$(REGION) --format='value(status.url)'))
	curl -X POST $(SERVICE_URL)/sync \
		-H "Content-Type: application/json" \
		-d '{"days_back": 30, "mode": "backfill"}'

scheduler-list: ## List Cloud Scheduler jobs
	gcloud scheduler jobs list --location=$(REGION)

scheduler-run: ## Manually run the daily scheduler job
	gcloud scheduler jobs run stock-price-daily-sync --location=$(REGION)

health-check: ## Check service health
	$(eval SERVICE_URL := $(shell gcloud run services describe $(SERVICE_NAME) --region=$(REGION) --format='value(status.url)'))
	curl $(SERVICE_URL)/health | jq .

clean: ## Clean up local Docker images
	docker rmi $(IMAGE_NAME):latest || true
	find . -type d -name "__pycache__" -exec rm -rf {} + || true
	find . -type f -name "*.pyc" -delete || true

format: ## Format Python code
	black *.py
	isort *.py

lint: ## Lint Python code
	pylint *.py
	mypy *.py

# Database operations
db-test-connection: ## Test database connection
	@python -c "import asyncio, asyncpg; \
		async def test(): \
			conn = await asyncpg.connect('$$DATABASE_URL'); \
			result = await conn.fetchval('SELECT 1'); \
			print('✅ Database connection successful'); \
			await conn.close(); \
		asyncio.run(test())"

db-check-data: ## Check recent stock price data
	@python -c "import asyncio, asyncpg; \
		async def check(): \
			conn = await asyncpg.connect('$$DATABASE_URL'); \
			count = await conn.fetchval('SELECT COUNT(*) FROM stock_prices WHERE date >= CURRENT_DATE - INTERVAL \"7 days\"'); \
			latest = await conn.fetchval('SELECT MAX(date) FROM stock_prices'); \
			print(f'Records (last 7 days): {count}'); \
			print(f'Latest data: {latest}'); \
			await conn.close(); \
		asyncio.run(check())"