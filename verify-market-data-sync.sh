#!/bin/bash
# Comprehensive verification script for market-data-sync and ASX discovery
# Usage: ./verify-market-data-sync.sh [SERVICE_URL] [GCS_BUCKET]

set -e

SERVICE_URL="${1:-https://market-data-sync-australia-southeast2-shorted-dev-aba5688f.a.run.app}"
GCS_BUCKET="${2:-shorted-short-selling-data}"

echo "🔍 Market Data Sync & ASX Discovery Verification"
echo "================================================"
echo "Service URL: $SERVICE_URL"
echo "GCS Bucket: $GCS_BUCKET"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check 1: Service Health
echo -e "${BLUE}1️⃣ Checking service health...${NC}"
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/healthz" 2>&1 || echo -e "\n000")
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Service is healthy${NC}"
    echo "Response: $BODY"
else
    echo -e "${RED}❌ Service health check failed (HTTP $HTTP_CODE)${NC}"
    echo "Response: $BODY"
    echo ""
    echo "⚠️  Service may not be deployed yet. Check GitHub Actions workflow."
    exit 1
fi
echo ""

# Check 2: Service Readiness
echo -e "${BLUE}2️⃣ Checking service readiness...${NC}"
READY_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/readyz" 2>&1 || echo -e "\n000")
HTTP_CODE=$(echo "$READY_RESPONSE" | tail -n1)
BODY=$(echo "$READY_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Service is ready${NC}"
    echo "Response: $BODY"
else
    echo -e "${YELLOW}⚠️  Service readiness check returned HTTP $HTTP_CODE${NC}"
    echo "Response: $BODY"
fi
echo ""

# Check 3: Verify GCS bucket has ASX stock list
echo -e "${BLUE}3️⃣ Checking GCS bucket for ASX stock list...${NC}"
if command -v gsutil &> /dev/null; then
    echo "Checking for asx-stocks/latest.csv in bucket $GCS_BUCKET..."
    if gsutil ls "gs://$GCS_BUCKET/asx-stocks/latest.csv" &>/dev/null; then
        echo -e "${GREEN}✅ ASX stock list found in GCS${NC}"
        
        # Get file info
        FILE_INFO=$(gsutil stat "gs://$GCS_BUCKET/asx-stocks/latest.csv" 2>/dev/null | grep -E "(Content-Length|Time created)" || echo "")
        if [ -n "$FILE_INFO" ]; then
            echo "File info:"
            echo "$FILE_INFO" | head -2
        fi
        
        # Count lines (approximate stock count)
        LINE_COUNT=$(gsutil cat "gs://$GCS_BUCKET/asx-stocks/latest.csv" 2>/dev/null | wc -l || echo "0")
        if [ "$LINE_COUNT" -gt 1 ]; then
            STOCK_COUNT=$((LINE_COUNT - 1)) # Subtract header
            echo -e "${GREEN}   Found ~$STOCK_COUNT stocks in CSV${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  ASX stock list not found in GCS${NC}"
        echo "   This means ASX discovery hasn't run yet or failed"
        echo "   You may need to manually trigger the asx-discovery job"
    fi
else
    echo -e "${YELLOW}⚠️  gsutil not found - skipping GCS check${NC}"
    echo "   Install gcloud SDK to verify GCS bucket contents"
fi
echo ""

# Check 4: Test single stock sync
echo -e "${BLUE}4️⃣ Testing single stock sync (BHP)...${NC}"
SYNC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SERVICE_URL/api/sync/stock/BHP" \
    -H "Content-Type: application/json" 2>&1 || echo -e "\n000")
HTTP_CODE=$(echo "$SYNC_RESPONSE" | tail -n1)
BODY=$(echo "$SYNC_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Stock sync initiated${NC}"
    echo "Response:"
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    
    # Extract run_id if present
    RUN_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('run_id', ''))" 2>/dev/null || echo "")
    if [ -n "$RUN_ID" ]; then
        echo ""
        echo -e "${BLUE}5️⃣ Checking sync status for run_id: $RUN_ID...${NC}"
        sleep 3
        STATUS_RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/api/sync/status/$RUN_ID" 2>&1 || echo -e "\n000")
        STATUS_HTTP_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)
        STATUS_BODY=$(echo "$STATUS_RESPONSE" | sed '$d')
        
        if [ "$STATUS_HTTP_CODE" = "200" ]; then
            echo -e "${GREEN}✅ Status check passed${NC}"
            echo "Status:"
            echo "$STATUS_BODY" | python3 -m json.tool 2>/dev/null || echo "$STATUS_BODY"
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

# Summary
echo -e "${BLUE}📋 Verification Summary${NC}"
echo "===================="
echo "✅ Service Health: $(if [ "$HTTP_CODE" = "200" ]; then echo "PASS"; else echo "FAIL"; fi)"
echo "✅ Service Readiness: $(if echo "$READY_RESPONSE" | tail -1 | grep -q "200"; then echo "PASS"; else echo "WARN"; fi)"
echo "✅ GCS Stock List: $(if command -v gsutil &> /dev/null && gsutil ls "gs://$GCS_BUCKET/asx-stocks/latest.csv" &>/dev/null; then echo "PASS"; else echo "WARN"; fi)"
echo "✅ Stock Sync: $(if [ "$HTTP_CODE" = "200" ]; then echo "PASS"; else echo "FAIL"; fi)"
echo ""
echo -e "${GREEN}✅ Verification complete!${NC}"
