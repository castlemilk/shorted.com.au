#!/usr/bin/env bash
# Post or retract a market move (docs/feature/market-moves/README.md).
#
#   scripts/market-moves/post-move.sh move.json          post (or revise) the move in move.json
#   echo '{...}' | scripts/market-moves/post-move.sh     post the move on stdin
#   scripts/market-moves/post-move.sh --retract KEY [REASON]
#
# Needs SHORTED_MARKET_MOVES_TOKEN (a token created at /admin/market-moves). The token
# travels in a header file, never on the command line, so it is not in `ps`.
# SHORTED_API_URL overrides the origin (default https://api.shorted.com.au; a local
# API is http://localhost:9091).
#
# Prints the API's JSON answer. Exits 0 on 2xx, 2 on a refusal the poster must fix
# (400, 404, 409 other than busy, 413, 415, 422, 429), 75 (EX_TEMPFAIL) on one worth
# retrying (409 busy, 503), 1 otherwise.
set -euo pipefail

: "${SHORTED_MARKET_MOVES_TOKEN:?set SHORTED_MARKET_MOVES_TOKEN to the market-moves publish token}"
api="${SHORTED_API_URL:-https://api.shorted.com.au}"
api="${api%/}"

umask 077
headers="$(mktemp)"
body="$(mktemp)"
answer="$(mktemp)"
trap 'rm -f "$headers" "$body" "$answer"' EXIT
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$SHORTED_MARKET_MOVES_TOKEN" >"$headers"

if [[ "${1:-}" == "--retract" ]]; then
  key="${2:?usage: post-move.sh --retract KEY [REASON]}"
  reason="${3:-}"
  KEY="$key" REASON="$reason" node -e \
    'process.stdout.write(JSON.stringify({move_key: process.env.KEY, reason: process.env.REASON || undefined}))' >"$body"
  path="/v1/market-moves/retract"
else
  if [[ -n "${1:-}" ]]; then
    cat -- "$1" >"$body"
  else
    cat >"$body"
  fi
  path="/v1/market-moves"
fi

status="$(curl -sS -o "$answer" -w '%{http_code}' -X POST -H @"$headers" --data-binary @"$body" "$api$path")"
cat "$answer"
echo

case "$status" in
  2??) exit 0 ;;
  503) exit 75 ;;
  409) grep -q '"retryable":true' "$answer" && exit 75 || exit 2 ;;
  400 | 404 | 413 | 415 | 422 | 429) exit 2 ;;
  401 | 403) echo "market-moves: the token was refused (HTTP $status); check SHORTED_MARKET_MOVES_TOKEN" >&2; exit 1 ;;
  *) echo "market-moves: unexpected HTTP $status" >&2; exit 1 ;;
esac
