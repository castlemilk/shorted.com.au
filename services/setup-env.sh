#!/bin/bash
# Setup environment variables for database operations

echo "🔐 Database Environment Setup"
echo "============================"
echo ""

# Check if .env file exists
if [ -f .env ]; then
    echo "📄 Loading existing .env file..."
    export $(cat .env | grep -v '^#' | xargs)
    echo "✅ Environment variables loaded from .env"
else
    echo "⚠️  No .env file found. Creating from .env.example..."
    cp .env.example .env
    echo "📝 Please edit .env file with your database credentials"
    echo ""
    echo "Example:"
    echo "  DATABASE_URL='postgresql://user:password@host:port/database'"
    echo ""
    exit 1
fi

# Verify DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL is not set in .env file"
    echo "Please add it to your .env file"
    exit 1
fi

# Test database connection
echo ""
echo "🔍 Testing database connection..."
if psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1; then
    echo "✅ Database connection successful!"
    
    # Show some stats
    echo ""
    echo "📊 Quick Stats:"
    psql "$DATABASE_URL" -t -c "SELECT 'Total stock records: ' || COUNT(DISTINCT stock_code) FROM stock_prices" 2>/dev/null
else
    echo "❌ Failed to connect to database"
    echo "Please check your DATABASE_URL in .env file"
    exit 1
fi

echo ""
echo "🎉 Environment ready! You can now run:"
echo "  make history.stock-data.status"
echo "  make history.stock-data.backfill-test"
echo "  make history.stock-data.backfill"