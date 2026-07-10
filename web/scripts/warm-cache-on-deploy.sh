#!/bin/sh
# Script to warm cache immediately after deployment
# This ensures cache is populated before first user requests

set -e

if [ "${SKIP_CACHE_WARM:-0}" = "1" ]; then
  echo "Skipping cache warm"
  exit 0
fi

echo "🔥 Warming cache on deployment..."

# Skip in development if backend services aren't running
if [ "${NODE_ENV:-}" = "development" ]; then
  echo "⚠️  Development mode: Skipping cache warm (backend services may not be ready)"
  exit 0
fi

# Get the deployment URL from environment or use default
DEPLOYMENT_URL="${VERCEL_URL:-http://localhost:3020}"
WARM_SECRET="${CACHE_WARM_SECRET:-}"

# Build the URL with optional secret
if [ -n "$WARM_SECRET" ]; then
  WARM_URL="${DEPLOYMENT_URL}/api/about/warm-cache?secret=${WARM_SECRET}"
else
  WARM_URL="${DEPLOYMENT_URL}/api/about/warm-cache"
fi

echo "Calling: ${WARM_URL}"

# Warm about page cache with timeout
curl -f -s --max-time 30 "${WARM_URL}" > /dev/null || {
  echo "⚠️  Warning: Cache warm failed (this is OK if services aren't ready yet)"
}

# Also warm homepage cache if endpoint exists
if [ -n "$WARM_SECRET" ]; then
  HOME_URL="${DEPLOYMENT_URL}/api/homepage/warm-cache?secret=${WARM_SECRET}"
else
  HOME_URL="${DEPLOYMENT_URL}/api/homepage/warm-cache"
fi

curl -f -s --max-time 30 "${HOME_URL}" > /dev/null || {
  echo "⚠️  Warning: Homepage cache warm failed (endpoint may not exist yet)"
}

# Warm the industry-intelligence data chain (industry index, top-shorts series,
# per-industry evidence snapshots) so the first visitor never pays a cold
# backend fan-out.
curl -f -s --max-time 55 "${DEPLOYMENT_URL}/industry-intelligence" > /dev/null || {
  echo "⚠️  Warning: Industry intelligence warm failed (this is OK if services aren't ready yet)"
}

echo "✅ Cache warming complete"
