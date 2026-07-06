#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
VERCEL_SCOPE="${VERCEL_SCOPE:-document-analyser}"
RELEASE_API_BASE_URL="${RELEASE_API_BASE_URL:-https://api.shorted.com.au}"
PROMOTE_TO_PROD="${PROMOTE_TO_PROD:-0}"
RELEASE_CONFIRM_PROMOTE="${RELEASE_CONFIRM_PROMOTE:-0}"

stage() {
  echo ""
  echo "==> $1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

append_endpoint_args() {
  local name="$1"
  local value="$2"
  if [ -n "$value" ]; then
    VERCEL_DEPLOY_ARGS+=("--env" "${name}=${value}")
  fi
}

export_release_env() {
  if [ -n "${RELEASE_SHORTS_SERVICE_ENDPOINT:-}" ]; then
    export SHORTS_SERVICE_ENDPOINT="$RELEASE_SHORTS_SERVICE_ENDPOINT"
    export NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT="$RELEASE_SHORTS_SERVICE_ENDPOINT"
    export NEXT_PUBLIC_SHORTS_API_URL="$RELEASE_SHORTS_SERVICE_ENDPOINT"
  fi
  if [ -n "${RELEASE_MARKET_DATA_API_URL:-}" ]; then
    export MARKET_DATA_API_URL="$RELEASE_MARKET_DATA_API_URL"
    export NEXT_PUBLIC_MARKET_DATA_API_URL="$RELEASE_MARKET_DATA_API_URL"
  fi
  if [ -n "${CLOUDFLARE_TESTING_BYPASS_SECRET:-}" ]; then
    export SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET="$CLOUDFLARE_TESTING_BYPASS_SECRET"
  fi
}

extract_preview_url() {
  local log_file="$1"
  grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' "$log_file" | tail -n 1
}

require_command node
require_command npm
require_command npx
require_command vercel

export_release_env

stage "build"
rm -rf "$WEB_DIR/.next" "$ROOT_DIR/.vercel/output" "$WEB_DIR/.vercel/output"
(
  cd "$ROOT_DIR"
  node --test \
    scripts/release-pipeline.test.mjs \
    services/edge-worker/analytics.test.mjs \
    terraform/modules/cloudflare-edge/rate-limit-expression.test.mjs
)
(
  cd "$WEB_DIR"
  npm run lint -- \
    --file 'e2e/release-smoke.spec.ts' \
    --file 'src/app/shorts/[stockCode]/page.tsx' \
    --file 'src/app/market/[date]/page.tsx'
  npm test -- --runTestsByPath \
    'src/app/shorts/[stockCode]/__tests__/page-runtime.test.tsx' \
    'src/app/market/[date]/__tests__/page-runtime.test.tsx' \
    'src/app/reports/__tests__/page-runtime.test.tsx' \
    'src/@/components/company/__tests__/stock-verdict.test.tsx' \
    src/app/actions/__tests__/serverApiSurface.test.ts
  npm run build
)

stage "vercel-build"
VERCEL_BUILD_ARGS=(
  "--yes" "--target" "production"
  "--scope" "$VERCEL_SCOPE"
)
if [ -n "${VERCEL_TOKEN:-}" ]; then
  VERCEL_BUILD_ARGS+=("--token" "$VERCEL_TOKEN")
fi
(
  cd "$ROOT_DIR"
  vercel build "${VERCEL_BUILD_ARGS[@]}"
)

stage "deploy-preview"
VERCEL_DEPLOY_ARGS=(
  "--prebuilt" "--yes" "--target" "production" "--force" "--skip-domain"
  "--scope" "$VERCEL_SCOPE"
  "--archive=tgz"
)
if [ -n "${VERCEL_TOKEN:-}" ]; then
  VERCEL_DEPLOY_ARGS+=("--token" "$VERCEL_TOKEN")
fi

append_endpoint_args "SHORTS_SERVICE_ENDPOINT" "${RELEASE_SHORTS_SERVICE_ENDPOINT:-}"
append_endpoint_args "NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT" "${RELEASE_SHORTS_SERVICE_ENDPOINT:-}"
append_endpoint_args "NEXT_PUBLIC_SHORTS_API_URL" "${RELEASE_SHORTS_SERVICE_ENDPOINT:-}"
append_endpoint_args "MARKET_DATA_API_URL" "${RELEASE_MARKET_DATA_API_URL:-}"
append_endpoint_args "NEXT_PUBLIC_MARKET_DATA_API_URL" "${RELEASE_MARKET_DATA_API_URL:-}"
append_endpoint_args "SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET" "${CLOUDFLARE_TESTING_BYPASS_SECRET:-}"

DEPLOY_LOG="$(mktemp)"
(
  cd "$ROOT_DIR"
  vercel deploy "${VERCEL_DEPLOY_ARGS[@]}"
) | tee "$DEPLOY_LOG"

PREVIEW_URL="$(extract_preview_url "$DEPLOY_LOG")"
if [ -z "$PREVIEW_URL" ]; then
  echo "Could not extract Vercel preview URL from deploy output" >&2
  exit 1
fi
echo "Preview URL: $PREVIEW_URL"

stage "smoke"
(
  cd "$WEB_DIR"
  BASE_URL="$PREVIEW_URL" \
  RELEASE_API_BASE_URL="$RELEASE_API_BASE_URL" \
  CLOUDFLARE_TESTING_BYPASS_SECRET="${CLOUDFLARE_TESTING_BYPASS_SECRET:-}" \
  node e2e/release-smoke-ci.mjs
)

stage "promote-prod"
if [ "$PROMOTE_TO_PROD" = "1" ]; then
  if [ "$RELEASE_CONFIRM_PROMOTE" != "1" ]; then
    echo "Refusing to promote. Set RELEASE_CONFIRM_PROMOTE=1 as an explicit production confirmation." >&2
    exit 1
  fi

  PROMOTE_ARGS=("$PREVIEW_URL" "--scope" "$VERCEL_SCOPE" "--yes")
  if [ -n "${VERCEL_TOKEN:-}" ]; then
    PROMOTE_ARGS+=("--token" "$VERCEL_TOKEN")
  fi
  vercel promote "${PROMOTE_ARGS[@]}"
else
  echo "Smoke passed. Promote this exact deployment with:"
  echo "  vercel promote $PREVIEW_URL --scope $VERCEL_SCOPE --yes"
  echo ""
  echo "To run the full pipeline and promote after smoke in one pass:"
  echo "  PROMOTE_TO_PROD=1 RELEASE_CONFIRM_PROMOTE=1 npm run release:web"
fi
