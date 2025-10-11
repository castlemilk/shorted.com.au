#!/bin/bash

# E2E Test Runner Script
# Sets up backend services, seeds test data, and runs E2E tests

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$PROJECT_ROOT/web"
SERVICES_DIR="$PROJECT_ROOT/services"
TEST_MODE="${1:-local}" # local or ci
HEADLESS="${HEADLESS:-true}"

# Ports
WEB_PORT=3020
SHORTS_PORT=9091
MARKET_DATA_PORT=8090

# PIDs for cleanup
WEB_PID=""
SHORTS_PID=""
MARKET_DATA_PID=""

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    
    # Kill services
    if [ ! -z "$WEB_PID" ]; then
        echo "Stopping web server (PID: $WEB_PID)..."
        kill $WEB_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$SHORTS_PID" ]; then
        echo "Stopping shorts service (PID: $SHORTS_PID)..."
        kill $SHORTS_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$MARKET_DATA_PID" ]; then
        echo "Stopping market data service (PID: $MARKET_DATA_PID)..."
        kill $MARKET_DATA_PID 2>/dev/null || true
    fi
    
    # Kill any remaining processes on our ports
    lsof -ti:$WEB_PORT | xargs kill -9 2>/dev/null || true
    lsof -ti:$SHORTS_PORT | xargs kill -9 2>/dev/null || true
    lsof -ti:$MARKET_DATA_PORT | xargs kill -9 2>/dev/null || true
    
    echo -e "${GREEN}Cleanup complete${NC}"
}

# Set up trap for cleanup
trap cleanup EXIT INT TERM

echo -e "${GREEN}🚀 Starting E2E Test Suite${NC}"
echo "Mode: $TEST_MODE"
echo "Project root: $PROJECT_ROOT"
echo ""

# Step 1: Check prerequisites
echo -e "${YELLOW}📋 Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    exit 1
fi

# Check Go
if ! command -v go &> /dev/null; then
    echo -e "${RED}❌ Go is not installed${NC}"
    exit 1
fi

# Check if ports are available
for port in $WEB_PORT $SHORTS_PORT $MARKET_DATA_PORT; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}❌ Port $port is already in use${NC}"
        echo "Please stop the service using this port and try again"
        exit 1
    fi
done

echo -e "${GREEN}✅ Prerequisites check passed${NC}\n"

# Step 2: Install dependencies
echo -e "${YELLOW}📦 Installing dependencies...${NC}"

cd "$WEB_DIR"
if [ ! -d "node_modules" ]; then
    npm install
fi

# Install Playwright browsers if needed
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
    npx playwright install chromium
fi

echo -e "${GREEN}✅ Dependencies installed${NC}\n"

# Step 3: Build services
echo -e "${YELLOW}🔨 Building backend services...${NC}"

# Build shorts service
cd "$SERVICES_DIR/shorts"
echo "Building shorts service..."
go build -o shorts-service ./cmd/server

# Build market data service
cd "$SERVICES_DIR/market-data"
echo "Building market data service..."
go build -o market-data-service .

echo -e "${GREEN}✅ Services built${NC}\n"

# Step 4: Start backend services
echo -e "${YELLOW}🚀 Starting backend services...${NC}"

# Set database URL (use test database in CI mode)
if [ "$TEST_MODE" = "ci" ]; then
    export DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
else
    export DATABASE_URL="${DATABASE_URL:-postgres://postgres.vfzzkelbpyjdvuujyrpu:bxmsrFPazXawzeav@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres}"
fi

# If a DATABASE_URL is available, parse it and export settings for the shorts service
if [ -n "${DATABASE_URL:-}" ]; then
    # Expected format: postgres://user:pass@host:port/db
    __db_rest="${DATABASE_URL#*://}"
    __db_user="${__db_rest%%:*}"
    __db_rest="${__db_rest#*:}"
    __db_pass="${__db_rest%%@*}"
    __db_rest="${__db_rest#*@}"
    __db_hostport="${__db_rest%%/*}"
    __db_host="${__db_hostport%%:*}"
    __db_port="${__db_hostport#*:}"
    __db_name="${__db_rest#*/}"

    export APP_STORE_POSTGRES_ADDRESS="${__db_host}:${__db_port}"
    export APP_STORE_POSTGRES_USERNAME="${__db_user}"
    export APP_STORE_POSTGRES_PASSWORD="${__db_pass}"
    export APP_STORE_POSTGRES_DATABASE="${__db_name}"
fi

# Start shorts service
cd "$SERVICES_DIR/shorts"
echo "Starting shorts service on port $SHORTS_PORT..."
./shorts-service > "$PROJECT_ROOT/shorts.log" 2>&1 &
SHORTS_PID=$!

# Start market data service
cd "$SERVICES_DIR/market-data"
echo "Starting market data service on port $MARKET_DATA_PORT..."
./market-data-service > "$PROJECT_ROOT/market-data.log" 2>&1 &
MARKET_DATA_PID=$!

# Wait for services to be ready
echo "Waiting for backend services to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:$SHORTS_PORT/health >/dev/null 2>&1 && \
       curl -s http://localhost:$MARKET_DATA_PORT/health >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Backend services are ready${NC}\n"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ Backend services failed to start${NC}"
        echo "Check logs:"
        echo "  Shorts: $PROJECT_ROOT/shorts.log"
        echo "  Market data: $PROJECT_ROOT/market-data.log"
        exit 1
    fi
    sleep 1
done

# Step 5: Seed test data (optional, skip if using production data)
if [ "$TEST_MODE" = "ci" ]; then
    echo -e "${YELLOW}🌱 Seeding test database...${NC}"
    cd "$WEB_DIR"
    npm run test:seed || true
    echo -e "${GREEN}✅ Test data seeded${NC}\n"
fi

# Step 6: Start web server
echo -e "${YELLOW}🌐 Starting web server...${NC}"
cd "$WEB_DIR"

# Build the app first
echo "Building Next.js app..."
npm run build

# Start the server
echo "Starting web server on port $WEB_PORT..."
npm run start > "$PROJECT_ROOT/web.log" 2>&1 &
WEB_PID=$!

# Wait for web server to be ready
echo "Waiting for web server to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:$WEB_PORT >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Web server is ready${NC}\n"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ Web server failed to start${NC}"
        echo "Check log: $PROJECT_ROOT/web.log"
        exit 1
    fi
    sleep 1
done

# Step 7: Run E2E tests
echo -e "${YELLOW}🧪 Running E2E tests...${NC}"
cd "$WEB_DIR"

# Set test environment variables
export BASE_URL="http://localhost:$WEB_PORT"
export API_URL="http://localhost:$SHORTS_PORT"
export MARKET_DATA_URL="http://localhost:$MARKET_DATA_PORT"

# Run tests
if [ "$HEADLESS" = "true" ]; then
    echo "Running tests in headless mode..."
    npx playwright test e2e/full-stack-e2e.spec.ts
else
    echo "Running tests with UI..."
    npx playwright test e2e/full-stack-e2e.spec.ts --headed
fi

TEST_EXIT_CODE=$?

# Step 8: Generate report
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "\n${GREEN}✅ All E2E tests passed!${NC}"
else
    echo -e "\n${RED}❌ Some tests failed${NC}"
    echo "Generating test report..."
    npx playwright show-report
fi

# Show service logs if tests failed
if [ $TEST_EXIT_CODE -ne 0 ] && [ "$TEST_MODE" = "local" ]; then
    echo -e "\n${YELLOW}📋 Service logs:${NC}"
    echo "--- Web Server (last 20 lines) ---"
    tail -20 "$PROJECT_ROOT/web.log" || true
    echo ""
    echo "--- Shorts Service (last 20 lines) ---"
    tail -20 "$PROJECT_ROOT/shorts.log" || true
    echo ""
    echo "--- Market Data Service (last 20 lines) ---"
    tail -20 "$PROJECT_ROOT/market-data.log" || true
fi

exit $TEST_EXIT_CODE