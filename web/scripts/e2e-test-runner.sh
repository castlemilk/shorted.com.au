#!/bin/bash
# E2E Test Runner Script
# Starts all necessary dependencies and runs E2E tests

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Trap to ensure cleanup happens
cleanup() {
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    # Kill services by port
    lsof -ti:3020 | xargs kill -9 2>/dev/null || true  # Frontend
    lsof -ti:9091 | xargs kill -9 2>/dev/null || true  # Backend shorts service
    lsof -ti:8090 | xargs kill -9 2>/dev/null || true  # Mock market data service
    
    # Kill any remaining node processes
    pkill -f "next dev" 2>/dev/null || true
    pkill -f "mock-market-data.js" 2>/dev/null || true
    pkill -f "go run" 2>/dev/null || true
    
    echo -e "${GREEN}Cleanup complete${NC}"
}

trap cleanup EXIT

# Function to wait for service
wait_for_service() {
    local url=$1
    local service_name=$2
    local max_attempts=30
    local attempt=1
    
    echo -e "${YELLOW}Waiting for $service_name...${NC}"
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s --fail "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}$service_name is ready${NC}"
            return 0
        fi
        echo "Attempt $attempt/$max_attempts: $service_name not ready yet..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}$service_name failed to start after $max_attempts attempts${NC}"
    return 1
}

# Function to check if port is in use
is_port_in_use() {
    lsof -i:$1 > /dev/null 2>&1
}

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}     E2E Test Runner${NC}"
echo -e "${GREEN}========================================${NC}"

# Step 1: Check environment
echo -e "\n${YELLOW}Step 1: Checking environment...${NC}"

# Check for required commands
for cmd in node npm go curl; do
    if ! command -v $cmd &> /dev/null; then
        echo -e "${RED}Error: $cmd is not installed${NC}"
        exit 1
    fi
done

# Check for .env.local
if [ ! -f "web/.env.local" ]; then
    echo -e "${YELLOW}Creating .env.local from example...${NC}"
    cp web/.env.local.example web/.env.local
    echo -e "${GREEN}.env.local created${NC}"
fi

# Step 2: Install dependencies
echo -e "\n${YELLOW}Step 2: Installing dependencies...${NC}"
cd web && npm install --silent && cd ..
echo -e "${GREEN}Dependencies installed${NC}"

# Step 3: Kill any existing services on our ports
echo -e "\n${YELLOW}Step 3: Cleaning up existing services...${NC}"
cleanup

# Step 4: Start Mock Market Data Service
echo -e "\n${YELLOW}Step 4: Starting Mock Market Data Service...${NC}"
cd services
node mock-market-data.js > /tmp/mock-market-data.log 2>&1 &
MOCK_PID=$!
cd ..
wait_for_service "http://localhost:8090/health" "Mock Market Data Service"

# Step 5: Start Backend Service
echo -e "\n${YELLOW}Step 5: Starting Backend Service...${NC}"
cd services
make run.shorts > /tmp/shorts-service.log 2>&1 &
BACKEND_PID=$!
cd ..
wait_for_service "http://localhost:9091/health" "Backend Service"

# Step 6: Build and Start Frontend
echo -e "\n${YELLOW}Step 6: Starting Frontend...${NC}"
cd web
npm run dev > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..
wait_for_service "http://localhost:3020" "Frontend"

# Step 7: Run E2E Tests
echo -e "\n${YELLOW}Step 7: Running E2E Tests...${NC}"
echo -e "${GREEN}========================================${NC}"

cd web

# Check if we should run in UI mode
if [ "$1" = "--ui" ]; then
    echo -e "${YELLOW}Running Playwright in UI mode...${NC}"
    npx playwright test --ui
elif [ "$1" = "--headed" ]; then
    echo -e "${YELLOW}Running Playwright in headed mode...${NC}"
    npx playwright test --headed
else
    echo -e "${YELLOW}Running Playwright tests...${NC}"
    npx playwright test
fi

TEST_EXIT_CODE=$?

cd ..

# Step 8: Report results
echo -e "\n${GREEN}========================================${NC}"
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ E2E Tests Passed!${NC}"
else
    echo -e "${RED}❌ E2E Tests Failed${NC}"
    echo -e "${YELLOW}Check the logs:${NC}"
    echo "  - Frontend: /tmp/frontend.log"
    echo "  - Backend: /tmp/shorts-service.log"
    echo "  - Mock Service: /tmp/mock-market-data.log"
fi

exit $TEST_EXIT_CODE