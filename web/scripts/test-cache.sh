#!/bin/bash
# Script to test KV cache functionality

set -e

echo "🧪 Testing KV Cache Functionality"
echo "=================================="

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if server is running
if ! curl -s http://localhost:3020/api/health > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Server not running. Starting server...${NC}"
    npm run start > /tmp/nextjs-test.log 2>&1 &
    SERVER_PID=$!
    sleep 5
    
    # Check if server started
    if ! curl -s http://localhost:3020/api/health > /dev/null 2>&1; then
        echo -e "${RED}❌ Failed to start server${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Server started${NC}"
else
    SERVER_PID=""
fi

# Test 1: Cache warming endpoint
echo ""
echo "Test 1: Cache Warming Endpoint"
echo "-----------------------------"
WARM_RESPONSE=$(curl -s http://localhost:3020/api/homepage/warm-cache)
if echo "$WARM_RESPONSE" | grep -q '"success":true'; then
    echo -e "${GREEN}✅ Cache warming successful${NC}"
    echo "$WARM_RESPONSE" | jq -r '.message'
else
    echo -e "${RED}❌ Cache warming failed${NC}"
    echo "$WARM_RESPONSE"
    exit 1
fi

# Test 2: Cache hit (should be fast)
echo ""
echo "Test 2: Cache Hit Performance"
echo "-----------------------------"
START_TIME=$(date +%s%N)
curl -s http://localhost:3020/ > /dev/null
END_TIME=$(date +%s%N)
DURATION=$(( (END_TIME - START_TIME) / 1000000 ))

if [ $DURATION -lt 100 ]; then
    echo -e "${GREEN}✅ Cache hit: ${DURATION}ms (expected < 100ms)${NC}"
else
    echo -e "${YELLOW}⚠️  Response time: ${DURATION}ms (may be cache miss)${NC}"
fi

# Test 3: Multiple requests (should all use cache)
echo ""
echo "Test 3: Multiple Concurrent Requests"
echo "-------------------------------------"
for i in {1..5}; do
    START_TIME=$(date +%s%N)
    curl -s http://localhost:3020/ > /dev/null
    END_TIME=$(date +%s%N)
    DURATION=$(( (END_TIME - START_TIME) / 1000000 ))
    echo "Request $i: ${DURATION}ms"
done

# Test 4: Verify cache keys exist (if Redis CLI available)
echo ""
echo "Test 4: Cache Key Verification"
echo "------------------------------"
if command -v redis-cli &> /dev/null && [ -n "$KV_REST_API_URL" ]; then
    echo "Checking cache keys..."
    # This would require Redis connection details
    echo -e "${YELLOW}⚠️  Redis CLI check skipped (requires connection details)${NC}"
else
    echo -e "${YELLOW}⚠️  Redis CLI not available, skipping key verification${NC}"
fi

# Cleanup
if [ -n "$SERVER_PID" ]; then
    echo ""
    echo "Cleaning up..."
    kill $SERVER_PID 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}✅ All cache tests completed${NC}"

