#!/usr/bin/env bash
# Fast, reproducible local verification for git hooks and manual checks.
#
# Modes:
#   fast | pre-commit  deterministic unit/build checks, no service boot
#   full | pre-push    fast checks + lint + testcontainers integration when Docker is available
#   integration        testcontainers integration only

set -euo pipefail

MODE="${1:-fast}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use 2>/dev/null || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/go/bin:$PATH"

if [ -f "$REPO_ROOT/.nvmrc" ] && command -v nvm >/dev/null 2>&1; then
  nvm use --silent >/dev/null || true
fi

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export SKIP_ENV_VALIDATION="${SKIP_ENV_VALIDATION:-1}"
export SKIP_STATIC_GENERATION=1
export SKIP_VERSION_BUMP=1
export SKIP_CACHE_WARM=1
export GOMAXPROCS="${GOMAXPROCS:-4}"
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"
LOCAL_VERIFY_DOCKER_TIMEOUT="${LOCAL_VERIFY_DOCKER_TIMEOUT:-8}"

LOCAL_VERIFY_API_ORIGIN="${LOCAL_VERIFY_API_ORIGIN:-http://127.0.0.1:65535}"
if [ "${LOCAL_VERIFY_ALLOW_EXTERNAL:-0}" = "1" ]; then
  export SHORTS_SERVICE_ENDPOINT="${SHORTS_SERVICE_ENDPOINT:-$LOCAL_VERIFY_API_ORIGIN}"
  export NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT="${NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT:-$LOCAL_VERIFY_API_ORIGIN}"
  export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-$LOCAL_VERIFY_API_ORIGIN}"
  export SHORTS_API_URL="${SHORTS_API_URL:-$LOCAL_VERIFY_API_ORIGIN}"
  export MARKET_DATA_API_URL="${MARKET_DATA_API_URL:-$LOCAL_VERIFY_API_ORIGIN}"
  export MARKET_DATA_URL="${MARKET_DATA_URL:-$LOCAL_VERIFY_API_ORIGIN}"
  export NEXT_PUBLIC_MARKET_DATA_API_URL="${NEXT_PUBLIC_MARKET_DATA_API_URL:-$LOCAL_VERIFY_API_ORIGIN}"
  export NEXT_PUBLIC_MARKET_DATA_URL="${NEXT_PUBLIC_MARKET_DATA_URL:-$LOCAL_VERIFY_API_ORIGIN}"
else
  export SHORTS_SERVICE_ENDPOINT="$LOCAL_VERIFY_API_ORIGIN"
  export NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT="$LOCAL_VERIFY_API_ORIGIN"
  export NEXT_PUBLIC_API_URL="$LOCAL_VERIFY_API_ORIGIN"
  export SHORTS_API_URL="$LOCAL_VERIFY_API_ORIGIN"
  export MARKET_DATA_API_URL="$LOCAL_VERIFY_API_ORIGIN"
  export MARKET_DATA_URL="$LOCAL_VERIFY_API_ORIGIN"
  export NEXT_PUBLIC_MARKET_DATA_API_URL="$LOCAL_VERIFY_API_ORIGIN"
  export NEXT_PUBLIC_MARKET_DATA_URL="$LOCAL_VERIFY_API_ORIGIN"
fi
export REDIS_URL=""
export KV_REST_API_URL=""
export KV_REST_API_TOKEN=""
export UPSTASH_REDIS_REST_URL=""
export UPSTASH_REDIS_REST_TOKEN=""
export CACHE_WARM_SECRET=""

cd "$REPO_ROOT"

section() {
  printf "\n==> %s\n" "$1"
}

format_duration() {
  local duration="$1"
  printf "%dm%02ds" "$((duration / 60))" "$((duration % 60))"
}

run() {
  local label="$1"
  shift
  local started="$SECONDS"
  local rc

  section "$label"
  set +e
  "$@"
  rc=$?
  set -e

  local duration=$((SECONDS - started))
  if [ "$rc" -eq 0 ]; then
    printf "==> %s complete (%s)\n" "$label" "$(format_duration "$duration")"
  else
    printf "==> %s failed after %s (exit %s)\n" "$label" "$(format_duration "$duration")" "$rc"
  fi

  return "$rc"
}

run_shell() {
  local label="$1"
  shift
  run "$label" bash -lc "$*"
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  local pid elapsed

  "$@" &
  pid=$!
  elapsed=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$pid"
}

docker_available() {
  command -v docker >/dev/null 2>&1 &&
    run_with_timeout "$LOCAL_VERIFY_DOCKER_TIMEOUT" docker info >/dev/null 2>&1
}

ensure_node_deps() {
  if [ ! -d "$REPO_ROOT/node_modules/yaml" ]; then
    run "Install root verifier dependencies" \
      npm install --ignore-scripts --prefer-offline --no-audit --no-fund
  fi

  if [ ! -d "$REPO_ROOT/web/node_modules" ]; then
    run "Install frontend dependencies" \
      npm --prefix web ci --prefer-offline --no-audit --no-fund
  fi
}

run_static_checks() {
  ensure_node_deps
  run "Git whitespace/conflict check" git diff --check
  run "Workflow/script guard tests" npm run test:workflow
  run "Release pipeline guard tests" npm run test:release-pipeline
}

run_backend_unit_tests() {
  run_shell "Backend unit tests (short mode)" "cd services && go test ./... -short"
}

run_frontend_unit_tests() {
  run_shell "Frontend unit tests" "cd web && npm test -- --runInBand"
}

run_frontend_build() {
  run_shell "Frontend build (backend-free static generation)" \
    "cd web && SKIP_STATIC_GENERATION=1 SKIP_VERSION_BUMP=1 SKIP_CACHE_WARM=1 SHORTED_DISABLE_CONNECT_FETCH_CACHE=true npm run build"
}

run_lint() {
  ensure_node_deps
  run "Frontend lint" make lint-frontend
  run "Backend lint" make lint-backend
}

run_testcontainers_integration() {
  if ! docker_available; then
    if [ "${LOCAL_VERIFY_REQUIRE_DOCKER:-0}" = "1" ]; then
      echo "Docker is required for testcontainers integration but is not available."
      exit 1
    fi
    echo "Docker is not available; testcontainers integration not run."
    echo "Set LOCAL_VERIFY_REQUIRE_DOCKER=1 to make this a hard failure."
    return 0
  fi

  run "Testcontainers integration" make test-integration-local
}

run_fast() {
  run_static_checks
  run_backend_unit_tests
  run_frontend_unit_tests
  run_frontend_build

  if [ "${LOCAL_VERIFY_INTEGRATION:-0}" = "1" ]; then
    run_testcontainers_integration
  fi
}

run_full() {
  run_lint
  run_fast

  if [ "${LOCAL_VERIFY_INTEGRATION:-auto}" != "0" ]; then
    run_testcontainers_integration
  fi
}

case "$MODE" in
  fast | pre-commit)
    run_fast
    ;;
  full | pre-push)
    run_full
    ;;
  integration | testcontainers)
    run_testcontainers_integration
    ;;
  *)
    echo "Usage: $0 [fast|pre-commit|full|pre-push|integration]"
    exit 64
    ;;
esac

section "Local verification complete"
