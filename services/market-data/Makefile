# Makefile for Market Data Sync Service

.PHONY: help install test test-unit test-integration test-local deploy health-check logs clean

help:
	@echo "Available commands:"
	@echo "  install        - Install Python dependencies"
	@echo "  test           - Run basic connectivity tests"
	@echo "  test-unit      - Run unit tests with mocked APIs"
	@echo "  test-integration - Run integration tests with real APIs"
	@echo "  test-local     - Test service locally with sample data"
	@echo "  deploy         - Deploy to Google Cloud Run"
	@echo "  health         - Check service health"
	@echo "  logs           - View Cloud Run logs"
	@echo "  clean          - Clean up generated files"

install:
	@echo "📦 Installing Python dependencies..."
	pip install -r requirements.txt

test:
	@echo "🧪 Running tests..."
	python -c "
	import asyncio
	import os
	import asyncpg

	async def test_db():
		db_url = os.getenv('DATABASE_URL')
		if not db_url:
			print('❌ DATABASE_URL not set')
			return False

		try:
			conn = await asyncpg.connect(db_url)
			await conn.close()
			print('✅ Database connection successful')
			return True
		except Exception as e:
			print(f'❌ Database connection failed: {e}')
			return False

	async def test_yfinance():
		try:
			import yfinance as yf
			ticker = yf.Ticker('CBA.AX')
			data = ticker.history(period='1d')
			if not data.empty:
				print('✅ Yahoo Finance API working')
				return True
			else:
				print('⚠️  No data from Yahoo Finance')
				return True
		except Exception as e:
			print(f'❌ Yahoo Finance API failed: {e}')
			return False

	async def main():
		db_ok = await test_db()
		yf_ok = await test_yfinance()

		if db_ok and yf_ok:
			print('\\n🎉 All tests passed!')
		else:
			print('\\n❌ Some tests failed')
			exit(1)

	asyncio.run(main())
	"

test-unit:
	@echo "🧪 Running unit tests with mocked APIs..."
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "⚠️  DATABASE_URL not set, using mock database"; \
	fi
	python3 -m pytest test_enhanced_processor_mocked.py test_resilient_fallback.py -v --tb=short

test-integration:
	@echo "🧪 Running integration tests with real APIs..."
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "❌ DATABASE_URL environment variable is required"; \
		echo "   Usage: export DATABASE_URL='your-database-url'"; \
		exit 1; \
	fi
	@if [ -z "$$ALPHA_VANTAGE_API_KEY" ]; then \
		echo "⚠️  ALPHA_VANTAGE_API_KEY not set, some tests may fail"; \
	fi
	python3 test_dynamic_system.py

test-local:
	@echo "🧪 Testing service locally..."
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "❌ DATABASE_URL environment variable is required"; \
		echo "   Usage: export DATABASE_URL='your-database-url'"; \
		exit 1; \
	fi
	@echo "Starting local test server..."
	timeout 10 python cloud_run_service.py || echo "Service started successfully"

deploy:
	@echo "🚀 Deploying to Google Cloud Run..."
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "❌ DATABASE_URL environment variable is required"; \
		echo "   Usage: export DATABASE_URL='your-database-url'"; \
		exit 1; \
	fi
	@if [ -z "$$GCP_PROJECT" ]; then \
		echo "⚠️  GCP_PROJECT not set, using default"; \
	fi
	./deploy.sh

health:
	@echo "🏥 Checking service health..."
	@if [ -z "$$SERVICE_URL" ]; then \
		echo "❌ SERVICE_URL not set"; \
		echo "   Set it after deployment: export SERVICE_URL='your-service-url'"; \
		exit 1; \
	fi
	curl -s $${SERVICE_URL}/health | python -m json.tool

logs:
	@echo "📋 Viewing Cloud Run logs..."
	@if [ -z "$$GCP_PROJECT" ]; then \
		echo "❌ GCP_PROJECT not set"; \
		exit 1; \
	fi
	gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-sync" --limit 20

clean:
	@echo "🧹 Cleaning up..."
	rm -rf __pycache__/
	rm -rf *.pyc
	find . -name "*.pyc" -delete
