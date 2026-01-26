.PHONY: test test-unit test-integration install-test-deps

# Install test dependencies
install-test-deps:
	pip install -r requirements.txt

# Run unit tests
test-unit:
	pytest test_checkpoint_retry.py -v

# Run all tests
test: test-unit

# Run with coverage
test-coverage:
	pytest test_checkpoint_retry.py --cov=comprehensive_daily_sync --cov-report=html --cov-report=term



