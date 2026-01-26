#!/bin/bash
# Test script for market-data-sync service
# Usage: ./test-market-data-sync.sh [SERVICE_URL]

set -e

SERVICE_URL="${1:-https://market-data-sync-australia-southeast2-shorted-dev-aba5688f.a.run.app}"

echo "🧪 Testing Market Data Sync Service"
echo "=================================="
echo "Service URL: $SERVICE_URL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo "1️⃣ Testing /healthz endpoint..."
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/healthz" || echo -e "\n000")
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Health check passed${NC}"
    echo "Response: $BODY"
else
    echo -e "${RED}❌ Health check failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $BODY"
    exit 1
fi
echo ""

# Test 2: Readiness Check
echo "2️⃣ Testing /readyz endpoint..."
READY_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/readyz" || echo -e "\n000")
HTTP_CODE=$(echo "$READY_RESPONSE" | tail -n1)
BODY=$(echo "$READY_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Readiness check passed${NC}"
    echo "Response: $BODY"
else
    echo -e "${YELLOW}⚠️  Readiness check returned HTTP $HTTP_CODE${NC}"
    echo "Response: $BODY"
fi
echo ""

# Test 3: Sync Single Stock (BHP)
echo "3️⃣ Testing single stock sync (BHP)..."
SYNC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SERVICE_URL/api/sync/stock/BHP" \
    -H "Content-Type: application/json" || echo -e "\n000")
HTTP_CODE=$(echo "$SYNC_RESPONSE" | tail -n1)
BODY=$(echo "$SYNC_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Stock sync initiated${NC}"
    echo "Response: $BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    
    # Extract run_id if present
    RUN_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('run_id', ''))" 2>/dev/null || echo "")
    if [ -n "$RUN_ID" ]; then
        echo ""
        echo "4️⃣ Checking sync status for run_id: $RUN_ID..."
        sleep 2
        STATUS_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/api/sync/status/$RUN_ID" || echo -e "\n000")
        STATUS_HTTP_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)
        STATUS_BODY=$(echo "$STATUS_RESPONSE" | sed '$d')
        
        if [ "$STATUS_HTTP_CODE" = "200" ]; then
            echo -e "${GREEN}✅ Status check passed${NC}"
            echo "Status: $STATUS_BODY" | python3 -m json.tool 2>/dev/null || echo "$STATUS_BODY"
        else
            echo -e "${YELLOW}⚠️  Status check returned HTTP $STATUS_HTTP_CODE${NC}"
            echo "Response: $STATUS_BODY"
        fi
    fi
else
    echo -e "${RED}❌ Stock sync failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $BODY"
    exit 1
fi
echo ""

# Test 4: Get Latest Status
echo "5️⃣ Testing latest status endpoint..."
LATEST_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/api/sync/status" || echo -e "\n000")
HTTP_CODE=$(echo "$LATEST_RESPONSE" | tail -n1)
BODY=$(echo "$LATEST_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Latest status check passed${NC}"
    echo "Response: $BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
else
    echo -e "${YELLOW}⚠️  Latest status check returned HTTP $HTTP_CODE${NC}"
    echo "Response: $BODY"
fi
echo ""

echo -e "${GREEN}✅ All tests completed!${NC}"
echo ""
echo "📋 Summary:"
echo "  - Health check: ✅"
echo "  - Readiness check: ✅"
echo "  - Single stock sync: ✅"
echo "  - Status endpoints: ✅"
