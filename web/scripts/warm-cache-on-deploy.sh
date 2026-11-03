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

# The deployment URL. VERCEL_URL has no scheme, and a bare host would send the
# credentials below over plain HTTP before any redirect.
if [ -n "${VERCEL_URL:-}" ]; then
  case "$VERCEL_URL" in
    http://*|https://*) DEPLOYMENT_URL="$VERCEL_URL" ;;
    *) DEPLOYMENT_URL="https://${VERCEL_URL}" ;;
  esac
else
  DEPLOYMENT_URL="http://localhost:3020"
fi
WARM_SECRET="${CACHE_WARM_SECRET:-}"

# Credentials go only to an https deployment. The local fallback is plain http,
# and a secret exported in the build shell must not reach whatever listens there.
case "$DEPLOYMENT_URL" in
  https://*) SEND_CREDENTIALS=1 ;;
  *)
    SEND_CREDENTIALS=
    if [ -n "${REVALIDATION_SECRET:-}" ] || [ -n "$WARM_SECRET" ]; then
      echo "Not sending credentials to ${DEPLOYMENT_URL}: only an https deployment gets them."
    fi
    ;;
esac

# The warm routes read credentials from headers, never the URL, because request
# logs keep URLs. REVALIDATION_SECRET goes as a bearer and CACHE_WARM_SECRET as
# X-Cache-Warm-Secret. Either one is enough. With neither, a Vercel deployment
# refuses the call.
warm_route() {
  url="$1"
  set -- -f -s --max-time 30
  if [ -n "$SEND_CREDENTIALS" ]; then
    if [ -n "${REVALIDATION_SECRET:-}" ]; then
      set -- "$@" -H "Authorization: Bearer ${REVALIDATION_SECRET}"
    fi
    if [ -n "$WARM_SECRET" ]; then
      set -- "$@" -H "X-Cache-Warm-Secret: ${WARM_SECRET}"
    fi
  fi
  curl "$@" "$url" > /dev/null
}

echo "Calling: ${DEPLOYMENT_URL}/api/about/warm-cache"

# Warm about page cache with timeout
warm_route "${DEPLOYMENT_URL}/api/about/warm-cache" || {
  echo "⚠️  Warning: Cache warm failed (this is OK if services aren't ready yet)"
}

# Also warm homepage cache if endpoint exists
warm_route "${DEPLOYMENT_URL}/api/homepage/warm-cache" || {
  echo "⚠️  Warning: Homepage cache warm failed (endpoint may not exist yet)"
}

# Warm the industry-intelligence data chain (industry index, top-shorts series,
# per-industry evidence snapshots) so the first visitor never pays a cold
# backend fan-out.
curl -f -s --max-time 55 "${DEPLOYMENT_URL}/industry-intelligence" > /dev/null || {
  echo "⚠️  Warning: Industry intelligence warm failed (this is OK if services aren't ready yet)"
}

echo "✅ Cache warming complete"
