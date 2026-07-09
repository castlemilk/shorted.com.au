#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/e2e/run_stripe_testmode_testbench.sh

Runs the Stripe test-mode checkout smoke bench against local web runtime.

Credential resolution order:
  1) STRIPE_TEST_* env vars
  2) STRIPE_* env vars
  3) local dotenv files (unless SKIP_DOTENV=1)

Required:
  - STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET_KEY)
  - STRIPE_TEST_PRO_PRICE_ID (or STRIPE_TEST_PRICE_ID or STRIPE_PRO_PRICE_ID)

Optional:
  - ALLOW_LIVE_STRIPE_KEYS=1 (disables safety guard requiring sk_test_*)
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

load_dotenv_file() {
  local file_path="$1"
  if [[ -f "$file_path" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file_path"
    set +a
  fi
}

if [[ "${SKIP_DOTENV:-0}" != "1" ]]; then
  load_dotenv_file "${ROOT_DIR}/.env"
  load_dotenv_file "${ROOT_DIR}/web/.env.local"
fi

stripe_secret_key="${STRIPE_TEST_SECRET_KEY:-${STRIPE_SECRET_KEY:-}}"
stripe_pro_price_id="${STRIPE_TEST_PRO_PRICE_ID:-${STRIPE_TEST_PRICE_ID:-${STRIPE_PRO_PRICE_ID:-${STRIPE_PREMIUM_PRICE_ID:-}}}}"
stripe_secret_key="${stripe_secret_key//$'\r'/}"
stripe_secret_key="${stripe_secret_key//$'\n'/}"
stripe_pro_price_id="${stripe_pro_price_id//$'\r'/}"
stripe_pro_price_id="${stripe_pro_price_id//$'\n'/}"

if [[ -z "$stripe_secret_key" ]]; then
  echo "missing Stripe secret key (set STRIPE_TEST_SECRET_KEY or STRIPE_SECRET_KEY)" >&2
  exit 1
fi
if [[ -z "$stripe_pro_price_id" ]]; then
  echo "missing Stripe PRO price id (set STRIPE_TEST_PRO_PRICE_ID, STRIPE_TEST_PRICE_ID, STRIPE_PRO_PRICE_ID, or STRIPE_PREMIUM_PRICE_ID)" >&2
  exit 1
fi

if [[ "${ALLOW_LIVE_STRIPE_KEYS:-0}" != "1" ]]; then
  if [[ "$stripe_secret_key" != sk_test_* ]]; then
    echo "refusing to run: expected Stripe test secret key (sk_test_*)" >&2
    echo "set ALLOW_LIVE_STRIPE_KEYS=1 only if this is intentional" >&2
    exit 1
  fi
fi

echo "Running Stripe test-mode checkout smoke bench..."

cd "${ROOT_DIR}/web"

STRIPE_SECRET_KEY="$stripe_secret_key" \
STRIPE_PRO_PRICE_ID="$stripe_pro_price_id" \
STRIPE_PREMIUM_PRICE_ID="$stripe_pro_price_id" \
STRIPE_API_ACCESS_PRICE_ID="${STRIPE_TEST_API_ACCESS_PRICE_ID:-${STRIPE_API_ACCESS_PRICE_ID:-}}" \
npm run stripe:preflight

STRIPE_SECRET_KEY="$stripe_secret_key" \
STRIPE_PRO_PRICE_ID="$stripe_pro_price_id" \
STRIPE_PREMIUM_PRICE_ID="$stripe_pro_price_id" \
ALLOW_E2E_AUTH="${ALLOW_E2E_AUTH:-true}" \
E2E_TEST_EMAIL="${E2E_TEST_EMAIL:-e2e-test@shorted.com.au}" \
E2E_TEST_PASSWORD="${E2E_TEST_PASSWORD:-E2ETestPassword123!}" \
npm run test:e2e:stripe-testmode
