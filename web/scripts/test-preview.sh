#!/bin/bash
# Test Vercel preview deployment with deployed backend services
# Usage: ./scripts/test-preview.sh <pr-number> <vercel-preview-url>

set -e

PR_NUMBER=$1
VERCEL_URL=$2

if [ -z "$PR_NUMBER" ] || [ -z "$VERCEL_URL" ]; then
  echo "Usage: $0 <pr-number> <vercel-preview-url>"
  echo ""
  echo "Example:"
  echo "  $0 123 https://pr-123-shorted.vercel.app"
  echo ""
  exit 1
fi

echo "🧪 Testing Vercel Preview with Backend Services"
echo "  PR: #$PR_NUMBER"
echo "  Frontend: $VERCEL_URL"
echo ""

# Construct backend URLs (standard naming convention)
SHORTS_URL="https://shorts-service-pr-${PR_NUMBER}.run.app"
MARKET_DATA_URL="https://market-data-service-pr-${PR_NUMBER}.run.app"

echo "📡 Checking backend services..."
echo "  Shorts API: $SHORTS_URL"
echo "  Market Data API: $MARKET_DATA_URL"
echo ""

# Check backend health
if curl -f -s "$SHORTS_URL/health" > /dev/null; then
  echo "✅ Shorts service is healthy"
else
  echo "❌ Shorts service not available at $SHORTS_URL"
  echo "   Check GitHub PR comment for actual URL"
  exit 1
fi

if curl -f -s "$MARKET_DATA_URL/health" > /dev/null; then
  echo "✅ Market Data service is healthy"
else
  echo "⚠️  Market Data service not available (may not be deployed yet)"
fi

echo ""
echo "🎭 Running Playwright E2E tests..."
echo ""

# Run Playwright tests against the preview
BASE_URL="$VERCEL_URL" \
SHORTS_URL="$SHORTS_URL" \
MARKET_DATA_URL="$MARKET_DATA_URL" \
npx playwright test

echo ""
echo "✅ E2E tests completed!"
echo ""
echo "📊 View test report:"
echo "  npx playwright show-report"
