#!/bin/bash

# Setup script for local development environment
# This script sets up the necessary services and data for the Shorted.com.au application

set -e

echo "🚀 Setting up Shorted.com.au local development environment..."

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check required dependencies
echo "📋 Checking dependencies..."

if ! command_exists node; then
    echo "❌ Node.js is required but not installed. Please install Node.js first."
    exit 1
fi

if ! command_exists npm; then
    echo "❌ npm is required but not installed. Please install npm first."
    exit 1
fi

if ! command_exists docker; then
    echo "❌ Docker is required but not installed. Please install Docker first."
    exit 1
fi

echo "✅ All dependencies found"

# Start PostgreSQL using Docker if not running
echo "🐘 Setting up PostgreSQL database..."

if ! docker ps | grep -q "postgres"; then
    echo "Starting PostgreSQL container..."
    cd analysis/sql
    docker-compose up -d
    
    # Wait for PostgreSQL to be ready
    echo "Waiting for PostgreSQL to be ready..."
    sleep 10
    
    # Check if database is ready
    while ! docker exec $(docker-compose ps -q postgres) pg_isready -U shorted; do
        echo "Waiting for PostgreSQL..."
        sleep 2
    done
    
    cd ../../
    echo "✅ PostgreSQL is ready"
else
    echo "✅ PostgreSQL is already running"
fi

# Install dependencies
echo "📦 Installing dependencies..."
cd web
npm install
cd ../services
go mod download
cd ..

# Set up environment variables if .env.local doesn't exist
echo "🔧 Setting up environment variables..."

if [ ! -f "web/.env.local" ]; then
    cat > web/.env.local << EOL
# Database
DATABASE_URL="postgresql://shorted:password@localhost:5432/shorted"

# Market Data API
NEXT_PUBLIC_MARKET_DATA_API_URL="http://localhost:8090"

# NextAuth.js
NEXTAUTH_SECRET="your-secret-key-here"
NEXTAUTH_URL="http://localhost:3020"

# Firebase (optional for development)
NEXT_PUBLIC_FIREBASE_PROJECT_ID="your-project-id"
NEXT_PUBLIC_FIREBASE_API_KEY="your-api-key"
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="your-sender-id"
NEXT_PUBLIC_FIREBASE_APP_ID="your-app-id"

# Shorts Service
SHORTS_SERVICE_ENDPOINT="http://localhost:9091"

# Skip environment validation during development
SKIP_ENV_VALIDATION=true
EOL
    echo "✅ Created web/.env.local with default values"
    echo "ℹ️  You may need to update the Firebase configuration with your actual values"
else
    echo "✅ web/.env.local already exists"
fi

# Load sample data into PostgreSQL
echo "📊 Loading sample data into PostgreSQL..."

# Check if we have any sample data scripts
if [ -f "analysis/sql/sample_data.sql" ]; then
    docker exec -i $(docker-compose -f analysis/sql/docker-compose.yml ps -q postgres) psql -U shorted -d shorted < analysis/sql/sample_data.sql
    echo "✅ Sample data loaded"
elif [ -f "analysis/sql/stock_prices_schema.sql" ]; then
    docker exec -i $(docker-compose -f analysis/sql/docker-compose.yml ps -q postgres) psql -U shorted -d shorted < analysis/sql/stock_prices_schema.sql
    echo "✅ Database schema loaded"
else
    echo "⚠️  No sample data found. You may need to run data sync services to populate the database."
fi

echo ""
echo "🎉 Local development environment setup complete!"
echo ""
echo "To start development:"
echo "1. Start the mock market data service:"
echo "   cd services && node mock-market-data.js"
echo ""
echo "2. Start the shorts service (in another terminal):"
echo "   cd services && make run.shorts"
echo ""
echo "3. Start the web application (in another terminal):"
echo "   cd web && npm run dev"
echo ""
echo "4. Visit http://localhost:3020 to see the application"
echo ""
echo "📚 For more information, see the README.md file"