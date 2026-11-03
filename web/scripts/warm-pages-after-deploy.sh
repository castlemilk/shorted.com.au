#!/bin/bash
# Warm ISR edge cache + KV cache after a production deployment.
#
# Usage:
#   ./scripts/warm-pages-after-deploy.sh                     # uses shorted.com.au
#   ./scripts/warm-pages-after-deploy.sh https://preview.vercel.app  # custom URL
#
# This script should be run AFTER `vercel --prod` completes, NOT during build.
# Needs REVALIDATION_SECRET (or CACHE_WARM_SECRET) exported: the routes refuse
# every call without one of them.
# It hits /api/warm-pages which fetches all critical pages to populate the
# Vercel edge CDN cache, eliminating cold hits for real users.

set -euo pipefail

DEPLOYMENT_URL="${1:-https://shorted.com.au}"
WARM_SECRET="${CACHE_WARM_SECRET:-}"

echo "Warming caches for: ${DEPLOYMENT_URL}"

# Credentials go in headers, never in the URL, because request logs keep URLs.
# REVALIDATION_SECRET is sent as a bearer and CACHE_WARM_SECRET as
# X-Cache-Warm-Secret. The expansions below use the ${arr[@]+...} form because
# bash 3.2 (macOS) rejects an empty array under set -u.
AUTH_ARGS=()
if [ -n "${REVALIDATION_SECRET:-}" ]; then
  AUTH_ARGS+=(-H "Authorization: Bearer ${REVALIDATION_SECRET}")
fi
if [ -n "$WARM_SECRET" ]; then
  AUTH_ARGS+=(-H "X-Cache-Warm-Secret: ${WARM_SECRET}")
fi

echo ""
echo "Step 1/3: Warming KV cache (homepage data)..."
curl -s --max-time 60 ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} "${DEPLOYMENT_URL}/api/homepage/warm-cache" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  {d.get(\"message\",\"done\")} ({d.get(\"duration\",\"?\")})')" 2>/dev/null || echo "  Warning: homepage KV warm failed (non-blocking)"

echo "Step 2/3: Warming KV cache (about data)..."
curl -s --max-time 30 ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} "${DEPLOYMENT_URL}/api/about/warm-cache" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  statistics={d.get(\"results\",{}).get(\"statistics\",\"?\")} topStocks={d.get(\"results\",{}).get(\"topStocks\",\"?\")}')" 2>/dev/null || echo "  Warning: about KV warm failed (non-blocking)"

echo "Step 3/3: Warming ISR page cache (25 pages)..."
RESULT=$(curl -s --max-time 180 ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} "${DEPLOYMENT_URL}/api/warm-pages" 2>/dev/null) || {
  echo "  Warning: ISR page warming timed out or failed (non-blocking)"
  echo "  Pages will be warmed by the hourly Vercel cron instead."
  exit 0
}

# Print summary
echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  {d[\"message\"]}')
pages = d.get('pages', [])
hits = sum(1 for p in pages if p.get('cache') == 'HIT')
misses = sum(1 for p in pages if p.get('cache') != 'HIT')
if misses > 0:
    print(f'  Cache: {hits} HIT, {misses} MISS/PRERENDER (first warm after deploy)')
else:
    print(f'  Cache: {hits} HIT (all pages already warm)')
" 2>/dev/null || echo "  $RESULT"

echo ""
echo "Cache warming complete."
