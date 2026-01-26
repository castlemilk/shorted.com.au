#!/bin/bash
# Development server launcher script
# Starts both frontend and backend services concurrently

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Trap Ctrl+C and kill all background processes
trap 'kill_all_processes' INT

kill_all_processes() {
    echo -e "\n${YELLOW}Stopping all services...${NC}"
    kill 0
    exit 0
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${RED}Error: Port $port is already in use${NC}"
        echo "Please stop the process using port $port and try again"
        return 1
    fi
    return 0
}

# Function to wait for a service to be ready
wait_for_service() {
    local name=$1
    local url=$2
    local max_attempts=30
    local attempt=0

    echo -e "${BLUE}Waiting for $name to be ready...${NC}"
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -f -s "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ $name is ready${NC}"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    echo -e "${RED}✗ $name failed to start${NC}"
    return 1
}

# Main execution
echo -e "${BLUE}🚀 Starting Shorted.com.au Development Environment${NC}"
echo "=================================================="

# Check if ports are available
echo -e "${BLUE}Checking port availability...${NC}"
check_port 3020 || exit 1
check_port 9091 || exit 1
echo -e "${GREEN}✓ Ports are available${NC}"

# Start backend service
echo -e "\n${BLUE}Starting backend service...${NC}"
(cd services && make run.shorts 2>&1 | sed 's/^/[BACKEND] /' ) &
BACKEND_PID=$!

# Give backend a moment to start
sleep 2

# Start frontend service
echo -e "\n${BLUE}Starting frontend service...${NC}"
(cd web && npm run dev 2>&1 | sed 's/^/[FRONTEND] /' ) &
FRONTEND_PID=$!

# Wait for services to be ready
echo -e "\n${BLUE}Waiting for services to start...${NC}"
wait_for_service "Backend" "http://localhost:9091/health" &
wait_for_service "Frontend" "http://localhost:3020" &
wait

# Display success message
echo -e "\n${GREEN}✅ All services are running!${NC}"
echo "=================================================="
echo -e "Frontend:  ${GREEN}http://localhost:3020${NC}"
echo -e "Backend:   ${GREEN}http://localhost:9091${NC}"
echo -e "\nPress ${YELLOW}Ctrl+C${NC} to stop all services"
echo "=================================================="

# Wait for all background processes
wait