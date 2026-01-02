#!/bin/bash
# Verify Preview Environment - Check if historical stock data loads correctly
#
# Usage:
#   ./scripts/verify-preview.sh [preview-url]
#
# Example:
#   ./scripts/verify-preview.sh https://preview.shorted.com.au
#   ./scripts/verify-preview.sh https://pr-123.shorted.vercel.app

set -e

PREVIEW_URL="${1:-https://preview.shorted.com.au}"
MARKET_DATA_URL="${2:-}"

echo "🔍 Verifying Preview Environment"
echo "================================"
echo "Preview URL: $PREVIEW_URL"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if URL is accessible
check_url() {
  local url=$1
  local name=$2
  
  echo -n "Checking $name... "
  if curl -sSf --max-time 10 "$url" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ OK${NC}"
    return 0
  else
    echo -e "${RED}❌ FAILED${NC}"
    return 1
  fi
}

# Function to check API endpoint
check_api() {
  local url=$1
  local name=$2
  
  echo -n "Checking $name API... "
  response=$(curl -sSf --max-time 10 "$url" 2>&1)
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ OK${NC}"
    echo "  Response: $(echo "$response" | head -c 100)..."
    return 0
  else
    echo -e "${RED}❌ FAILED${NC}"
    echo "  Error: $response"
    return 1
  fi
}

# Function to check historical data endpoint
check_historical_data() {
  local market_data_url=$1
  local stock_code=${2:-"WES"}
  
  if [ -z "$market_data_url" ]; then
    echo -e "${YELLOW}⚠️  Market Data URL not provided, skipping historical data check${NC}"
    return 0
  fi
  
  echo -n "Checking historical data for $stock_code... "
  
  response=$(curl -sSf --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"stockCode\":\"$stock_code\",\"period\":\"1m\"}" \
    "$market_data_url/api/market-data/historical" 2>&1)
  
  if [ $? -eq 0 ]; then
    # Check if response contains prices
    if echo "$response" | grep -q '"prices"'; then
      price_count=$(echo "$response" | grep -o '"prices"' | wc -l || echo "0")
      echo -e "${GREEN}✅ OK${NC}"
      echo "  Found prices data in response"
      return 0
    else
      echo -e "${YELLOW}⚠️  Response received but no prices found${NC}"
      echo "  Response: $(echo "$response" | head -c 200)..."
      return 1
    fi
  else
    echo -e "${RED}❌ FAILED${NC}"
    echo "  Error: $response"
    return 1
  fi
}

# Check preview frontend
echo "1. Frontend Checks"
echo "------------------"
if ! check_url "$PREVIEW_URL" "Preview Frontend"; then
  echo -e "${RED}❌ Preview frontend is not accessible${NC}"
  exit 1
fi

# Try to extract market data URL from page or use provided one
if [ -z "$MARKET_DATA_URL" ]; then
  echo ""
  echo -e "${YELLOW}ℹ️  To check historical data, provide the Market Data API URL:${NC}"
  echo "   ./scripts/verify-preview.sh $PREVIEW_URL https://market-data-service-pr-XXX.a.run.app"
  echo ""
else
  echo ""
  echo "2. Market Data API Checks"
  echo "------------------------"
  
  # Check health endpoint
  if check_url "$MARKET_DATA_URL/health" "Market Data Health"; then
    # Check historical data
    echo ""
    check_historical_data "$MARKET_DATA_URL" "WES"
    check_historical_data "$MARKET_DATA_URL" "CBA"
  fi
fi

echo ""
echo "================================"
echo -e "${GREEN}✅ Preview environment verification complete${NC}"
echo ""
echo "To test in browser:"
echo "  1. Visit: $PREVIEW_URL"
echo "  2. Navigate to a stock page (e.g., /shorts/WES)"
echo "  3. Check if historical price chart loads"
echo ""





