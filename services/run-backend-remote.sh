#!/bin/bash

# Script to run the backend API with remote Supabase database

echo "🚀 Starting Shorted Backend API with Remote Database"
echo "=================================================="

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable not set"
    echo "Please set it using: export DATABASE_URL='your-supabase-url'"
    exit 1
fi

# Parse DATABASE_URL to extract components
# Format: postgresql://username:password@host:port/database
if [[ $DATABASE_URL =~ postgresql://([^:]+):([^@]+)@([^/]+)/(.+) ]]; then
    USERNAME="${BASH_REMATCH[1]}"
    PASSWORD="${BASH_REMATCH[2]}"
    HOST_PORT="${BASH_REMATCH[3]}"
    DATABASE="${BASH_REMATCH[4]}"
    
    echo "📊 Database Configuration:"
    echo "  Host: $HOST_PORT"
    echo "  Database: $DATABASE"
    echo "  Username: $USERNAME"
    echo ""
else
    echo "❌ ERROR: Could not parse DATABASE_URL"
    exit 1
fi

# Kill any existing process on port 9091
echo "🧹 Cleaning up any existing services on port 9091..."
lsof -ti:9091 | xargs kill -9 2>/dev/null || true
sleep 1

# Set environment variables for the backend
export APP_STORE_BACKEND=postgres
export APP_STORE_POSTGRES_ADDRESS="$HOST_PORT"
export APP_STORE_POSTGRES_USERNAME="$USERNAME"
export APP_STORE_POSTGRES_PASSWORD="$PASSWORD"
export APP_STORE_POSTGRES_DATABASE="$DATABASE"
export APP_PORT=9091
export APP_INSECURE=true

echo "🔧 Environment configured:"
echo "  APP_STORE_BACKEND=postgres"
echo "  APP_STORE_POSTGRES_ADDRESS=$HOST_PORT"
echo "  APP_STORE_POSTGRES_DATABASE=$DATABASE"
echo "  APP_PORT=9091"
echo ""

# Change to services directory
cd /Users/benebsworth/projects/shorted/services

echo "🏃 Starting backend service..."
echo "  URL: http://localhost:9091"
echo ""
echo "Press Ctrl+C to stop the service"
echo "=================================================="
echo ""

# Run the backend
go run shorts/cmd/server/main.go