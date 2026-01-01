#!/bin/bash

# Trigger enrichment for DMP stock
# Uses ConnectRPC HTTP/1.1 format

STOCK_CODE="DMP"
FORCE="true"
API_URL="http://localhost:9091"
INTERNAL_SECRET="${INTERNAL_SECRET:-dev-internal-secret}"
USER_EMAIL="${USER_EMAIL:-e2e-test@shorted.com.au}"

echo "Triggering enrichment for $STOCK_CODE..."

# ConnectRPC uses POST with Content-Type: application/json
# The endpoint path format is /package.service/method
curl -X POST \
  "${API_URL}/shorts.v1alpha1.ShortedStocksService/EnrichStock" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: ${INTERNAL_SECRET}" \
  -H "X-User-Email: ${USER_EMAIL}" \
  -H "X-User-Id: test-user-id" \
  -d "{
    \"stockCode\": \"${STOCK_CODE}\",
    \"force\": ${FORCE}
  }" | jq '.'

echo ""
echo "Enrichment job triggered. Check logs for processing status."

