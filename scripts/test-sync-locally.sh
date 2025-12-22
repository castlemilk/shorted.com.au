#!/bin/bash
# Test the comprehensive daily sync locally to identify issues

set -e

echo "🧪 Testing Comprehensive Daily Sync Locally"
echo "=========================================="
echo ""

# Get DATABASE_URL from .env
if [ -f services/.env ]; then
    export DATABASE_URL=$(grep "^DATABASE_URL" services/.env | head -1 | cut -d '=' -f2-)
elif [ -f .env ]; then
    export DATABASE_URL=$(grep "^DATABASE_URL" .env | head -1 | cut -d '=' -f2-)
else
    echo "❌ No .env file found"
    exit 1
fi

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in .env files"
    exit 1
fi

echo "✅ DATABASE_URL found"
echo ""

# Check if we're in the right directory
if [ ! -f "services/daily-sync/comprehensive_daily_sync.py" ]; then
    echo "❌ comprehensive_daily_sync.py not found"
    echo "   Run this script from the project root"
    exit 1
fi

# Check Python dependencies
echo "📦 Checking Python dependencies..."
cd services/daily-sync

if ! python3 -c "import asyncpg" 2>/dev/null; then
    echo "⚠️  asyncpg not installed, installing..."
    python3 -m pip install asyncpg python-dotenv --user
fi

if ! python3 -c "import yfinance" 2>/dev/null; then
    echo "⚠️  yfinance not installed, installing..."
    python3 -m pip install yfinance pandas --user
fi

# Verify imports work
if ! python3 -c "import asyncpg, yfinance, pandas" 2>/dev/null; then
    echo "❌ Failed to import required modules"
    python3 -c "import asyncpg, yfinance, pandas" 2>&1
    exit 1
fi

echo "✅ Dependencies OK"
echo ""

# Set environment variables
export SYNC_DAYS_STOCK_PRICES=5
export SYNC_DAYS_SHORTS=7
export ENVIRONMENT=development

# Run the sync with timeout
echo "🚀 Running sync (with 5 minute timeout)..."
echo ""

timeout 300 python3 comprehensive_daily_sync.py 2>&1 | tee /tmp/sync-test.log

EXIT_CODE=$?

echo ""
echo "=========================================="
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Sync completed successfully"
elif [ $EXIT_CODE -eq 124 ]; then
    echo "⏱️  Sync timed out after 5 minutes"
else
    echo "❌ Sync failed with exit code: $EXIT_CODE"
fi

echo ""
echo "📋 Full log saved to: /tmp/sync-test.log"
echo ""

# Check for common errors
if grep -i "error\|exception\|traceback\|failed" /tmp/sync-test.log > /dev/null; then
    echo "🔍 Errors found in log:"
    grep -i "error\|exception\|traceback\|failed" /tmp/sync-test.log | head -10
fi


