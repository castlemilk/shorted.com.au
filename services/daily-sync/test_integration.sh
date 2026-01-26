#!/bin/bash
# Integration test runner for daily sync

set -e

echo "🧪 Running Daily Sync Integration Tests"
echo "=========================================="
echo ""

# Check environment
if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  DATABASE_URL not set, using default local database"
    export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"
fi

echo "📊 Database: ${DATABASE_URL}"

if [ -n "$ALPHA_VANTAGE_API_KEY" ]; then
    echo "🔑 Alpha Vantage: ENABLED"
else
    echo "⚠️  Alpha Vantage: DISABLED (no API key)"
fi

echo ""
echo "Installing test dependencies..."
pip3 install -r requirements.txt --quiet

echo ""
echo "Running tests..."
echo "=========================================="
python3 -m pytest test_daily_sync.py \
    -v \
    --tb=short \
    --color=yes \
    --durations=10

echo ""
echo "=========================================="
echo "✅ Tests complete!"

