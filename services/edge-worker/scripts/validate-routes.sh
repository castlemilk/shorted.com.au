#!/usr/bin/env bash
# validate-routes.sh
#
# E2E validation for the Shorted Cloudflare edge worker.
#
# Why this exists:
#   The worker has per-proto-package routing matchers (worker.js around
#   lines 143-165). A typo in any matcher causes silent fall-through to
#   the default origin, manifesting as "404 page not found" responses
#   to real frontend traffic. The latent `market_data.v1` vs
#   `marketdata.v1` typo broke the DMP stock page on 2026-04-27 and
#   went unnoticed for months because the frontend was bypassing the
#   worker entirely.
#
# What it checks (per proto package):
#   1. The route is reachable via api.shorted.com.au (worker → origin)
#   2. The same path is reachable direct-to-origin
#   3. The two responses agree on HTTP status (within tolerance)
#   4. No "404 page not found" — that's the worker fall-through signature
#
# Run:
#   bash services/edge-worker/scripts/validate-routes.sh
#   # or:
#   bash services/edge-worker/scripts/validate-routes.sh --quick    # skip direct-origin checks
#   bash services/edge-worker/scripts/validate-routes.sh --verbose  # show response bodies
#
# Exit codes:
#   0 — all routes healthy
#   1 — at least one route is broken
#   2 — config/setup error

set -uo pipefail

# ---------------------------------------------------------------------------
# Config — edit when origins move
# ---------------------------------------------------------------------------

EDGE_HOST="${EDGE_HOST:-https://api.shorted.com.au}"

# Direct origin URLs for each proto package.
# Update when migrating regions/services.
SHORTS_ORIGIN="${SHORTS_ORIGIN:-https://shorts-sg-334313144667.asia-southeast1.run.app}"
MARKETDATA_ORIGIN="${MARKETDATA_ORIGIN:-https://market-data-sg-334313144667.asia-southeast1.run.app}"
CHAT_ORIGIN="${CHAT_ORIGIN:-https://chat-service-334313144667.australia-southeast2.run.app}"

# Body to send for each test (deliberately minimal — we only care about
# routing, not auth/business-logic outcomes). 415/400/403/404-from-handler
# are all acceptable since they prove the request reached the right service.
TEST_BODY='{"stock_code":"DMP","ticker":"DMP"}'

# Tolerated status codes — anything in this set means "the request reached
# the right backend" even if the request itself was rejected.
# Intentionally excludes the literal "404 page not found" body which is
# Go's default-mux fall-through, indicating a routing bug.
ACCEPTABLE_CODES="200 400 403 404 405 415 422 501"

# Colors (skipped under CI / no-tty)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

# ---------------------------------------------------------------------------
# Test cases — one entry per (package, endpoint, expected origin role)
# Format: "<package>|<rpc-path>|<role>"
#   role: shorts | marketdata | register | chat
# ---------------------------------------------------------------------------

ROUTES=(
  "shorts.v1alpha1|/shorts.v1alpha1.ShortedStocksService/GetTopShorts|shorts"
  "shorts.v1alpha1|/shorts.v1alpha1.ShortedStocksService/GetStock|shorts"
  "shorts.v1alpha1|/shorts.v1alpha1.ShortedStocksService/GetStockDetails|shorts"
  "shorts.v1alpha1|/shorts.v1alpha1.ShortedStocksService/GetMarketByDate|shorts"
  "marketdata.v1|/marketdata.v1.MarketDataService/GetHistoricalPrices|marketdata"
  "marketdata.v1|/marketdata.v1.MarketDataService/GetStockPrice|marketdata"
  "register.v1|/register.v1.RegisterService/Register|register"
  "chat.v1|/chat.v1.ChatService/SendMessage|chat"
)

# Health-check endpoints (cheap GET, always 200)
HEALTH_TESTS=(
  "shorts:/health"
  "marketdata:/health"
  "chat:/health"
)

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

QUICK=false
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --verbose|-v) VERBOSE=true ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Hit a URL, return "<status>|<body-first-200-bytes>"
# Uses /usr/bin/curl explicitly to avoid PATH issues in some shells.
hit() {
  local url="$1"
  local body="${2:-$TEST_BODY}"
  local tmp; tmp=$(mktemp)
  local status
  status=$(/usr/bin/curl -sS --max-time 15 -o "$tmp" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    "$url" -d "$body" 2>/dev/null || echo "000")
  local out_body
  out_body=$(head -c 200 "$tmp" 2>/dev/null | tr -d '\n' | head -c 200)
  rm -f "$tmp"
  echo "$status|$out_body"
}

origin_for() {
  case "$1" in
    shorts) echo "$SHORTS_ORIGIN" ;;
    marketdata) echo "$MARKETDATA_ORIGIN" ;;
    chat) echo "$CHAT_ORIGIN" ;;
    register) echo "$SHORTS_ORIGIN" ;; # register lives in shorts service
    *) echo "" ;;
  esac
}

is_acceptable() {
  local code="$1"
  for ok in $ACCEPTABLE_CODES; do
    [ "$code" = "$ok" ] && return 0
  done
  return 1
}

# Detect the worker fall-through signature: 404 with body "404 page not found"
is_route_fallthrough() {
  local code="$1"
  local body="$2"
  [ "$code" = "404" ] && echo "$body" | grep -q "page not found"
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
FAILURES=()

echo "${CYAN}==> Validating edge routes via $EDGE_HOST${RESET}"
echo ""

for entry in "${ROUTES[@]}"; do
  pkg="${entry%%|*}"
  rest="${entry#*|}"
  rpc_path="${rest%|*}"
  role="${rest##*|}"

  edge_url="${EDGE_HOST}${rpc_path}"
  edge_result=$(hit "$edge_url")
  edge_code="${edge_result%%|*}"
  edge_body="${edge_result#*|}"

  if [ "$edge_code" = "000" ]; then
    echo "${RED}FAIL${RESET} $pkg $rpc_path — could not reach $EDGE_HOST"
    FAIL=$((FAIL+1))
    FAILURES+=("$pkg $rpc_path: edge unreachable")
    continue
  fi

  # Always hit the direct origin too so we can distinguish:
  #   (a) worker route fall-through  — edge returns "404 page not found"
  #       BUT direct returns something else
  #   (b) service-side handler missing — both return identical 404 page-not-found
  # Case (a) is a route bug; case (b) is just an unimplemented endpoint.
  direct_code=""
  direct_body=""
  if [ "$QUICK" = "false" ]; then
    direct_url="$(origin_for "$role")${rpc_path}"
    direct_result=$(hit "$direct_url")
    direct_code="${direct_result%%|*}"
    direct_body="${direct_result#*|}"
  fi

  # Only flag fall-through if edge says "page not found" AND direct disagrees.
  if is_route_fallthrough "$edge_code" "$edge_body"; then
    if [ -n "$direct_code" ] && is_route_fallthrough "$direct_code" "$direct_body"; then
      # Service genuinely doesn't implement this path (matches direct).
      # Pass with a note rather than failing.
      echo "${YELLOW}SKIP${RESET}  $pkg $rpc_path — handler not implemented (matches direct origin: HTTP $direct_code)"
      [ "$VERBOSE" = "true" ] && echo "       direct: $direct_body"
      PASS=$((PASS+1))
      continue
    fi
    echo "${RED}FAIL${RESET} $pkg $rpc_path — worker route fall-through (edge=$edge_code direct=$direct_code)"
    [ "$VERBOSE" = "true" ] && echo "       edge body: $edge_body"
    [ "$VERBOSE" = "true" ] && echo "       direct body: $direct_body"
    FAIL=$((FAIL+1))
    FAILURES+=("$pkg $rpc_path: worker route fall-through — direct origin returns $direct_code, but worker returns 404 page-not-found. Check services/edge-worker/worker.js for /$pkg./ matcher.")
    continue
  fi

  if ! is_acceptable "$edge_code"; then
    echo "${RED}FAIL${RESET} $pkg $rpc_path — unexpected HTTP $edge_code"
    [ "$VERBOSE" = "true" ] && echo "       body: $edge_body"
    FAIL=$((FAIL+1))
    FAILURES+=("$pkg $rpc_path: HTTP $edge_code")
    continue
  fi

  # Surface (but don't fail on) edge↔direct status divergence — sometimes
  # the worker rewrites/strips before returning, or auth flows differ.
  if [ "$QUICK" = "false" ] && [ "$direct_code" != "$edge_code" ] && [ "$direct_code" != "000" ]; then
    echo "${YELLOW}DIVERGE${RESET} $pkg $rpc_path — edge=$edge_code direct=$direct_code (worker may be transforming response)"
  fi

  PASS=$((PASS+1))
  if [ "$VERBOSE" = "true" ]; then
    echo "${GREEN}PASS${RESET}  $pkg $rpc_path — edge=$edge_code direct=${direct_code:-skipped}"
  else
    echo "${GREEN}PASS${RESET}  $pkg $rpc_path (HTTP $edge_code)"
  fi
done

# ---------------------------------------------------------------------------
# Health endpoints (cheap, validates origins are alive)
# ---------------------------------------------------------------------------

if [ "$QUICK" = "false" ]; then
  echo ""
  echo "${CYAN}==> Direct-origin health checks${RESET}"
  for entry in "${HEALTH_TESTS[@]}"; do
    role="${entry%%:*}"
    path="${entry##*:}"
    origin="$(origin_for "$role")"
    [ -z "$origin" ] && continue
    code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "${origin}${path}" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      echo "${GREEN}PASS${RESET}  $role $path -> 200"
      PASS=$((PASS+1))
    else
      echo "${RED}FAIL${RESET}  $role $path -> $code (origin: $origin)"
      FAIL=$((FAIL+1))
      FAILURES+=("$role health: HTTP $code")
    fi
  done
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "${GREEN}All checks passed${RESET} ($PASS/$TOTAL)"
  exit 0
else
  echo "${RED}$FAIL/$TOTAL checks failed:${RESET}"
  for msg in "${FAILURES[@]}"; do echo "  - $msg"; done
  echo ""
  echo "Common causes:"
  echo "  - Worker.js missing route matcher for a proto package (check services/edge-worker/worker.js)"
  echo "  - Cloud Run service URL changed (update SHORTS_ORIGIN / MARKETDATA_ORIGIN / CHAT_ORIGIN at top of this script)"
  echo "  - Cloudflare worker not yet propagated after terraform apply (wait 60s and retry)"
  exit 1
fi
