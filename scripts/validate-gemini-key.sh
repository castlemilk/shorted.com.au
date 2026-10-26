#!/usr/bin/env bash
#
# validate-gemini-key.sh [-|KEY] [MODEL]
#
# Proves a Gemini API key can GENERATE before scripts/ensure-secret.sh may write
# it to Secret Manager. Prints one line that never contains the key:
#
#   gemini key <sha256 prefix 12>: ok                      exit 0
#   gemini key <sha256 prefix 12>: rejected: <reason>      exit 2
#   gemini key <sha256 prefix 12>: unverified: <cause>     exit 3
#   gemini key: skipped (empty)                            exit 4
#
# Exit 2 means the key is refused: HTTP 400, 401 or 403 with the API's own
# reason, or a malformed key refused before any request (an embedded line break,
# or whitespace anywhere in it). Exit 3 means the answer is unknown: a network
# error, a 5xx or 429 that survived two retries, or a reply with no text. Exit 4
# means there was no key to test once trailing CR/LF are removed, so nothing may
# be written.
# Exit 1 is a usage error. Only exit 0 may lead to a write.
#
# WHY A GENERATION CALL: models.list answers 200 for keys that cannot generate.
# A service-account-bound key passed that check on 2026-10-23 and then failed
# every chat request with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED.
#
# HOW THE KEY ARRIVES: "-" reads it from stdin. The deploy calls it that way, so
# the key is never in the process table. A KEY given as an argument is for an
# operator at a terminal, and ps shows it for the length of the call.
#
# The key goes in the x-goog-api-key header, fed to curl on stdin (-H @-). It is
# never in a URL, where logs would keep it, and never written to disk. curl runs
# with -q, so no .curlrc can add a trace or verbose output. The only text taken
# from curl is a three-digit status code.
#
# Overrides: MODEL is the second argument, then GEMINI_VALIDATE_MODEL, then
# gemini-2.5-flash (the chat-service default in services/chat-service/config.go).
# GEMINI_VALIDATE_BASE_URL and GEMINI_VALIDATE_RETRY_DELAY_SEC exist for the
# tests. The base URL may point only at a loopback address, and that request is
# made with --noproxy so an http_proxy on the runner cannot relay the key in
# cleartext. The default https URL keeps any proxy, which can only tunnel TLS.

# Turn xtrace off before anything else, so `bash -x`, SHELLOPTS=xtrace and a
# BASH_ENV that sets -x never print the key. The redirect hides this line's own trace.
{ set +x; } 2>/dev/null

set -u

DEFAULT_BASE_URL="https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL="gemini-2.5-flash"
MAX_ATTEMPTS=3 # the first try plus two retries
LOOPBACK_RE='^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$'
MODEL_RE='^[A-Za-z0-9._-]+$'

if [ "$#" -lt 1 ]; then
  echo "usage: validate-gemini-key.sh [-|KEY] [MODEL]" >&2
  exit 1
fi

if [ "$1" = "-" ]; then
  # Reads all of stdin. With IFS empty and -r, read keeps every byte. It returns
  # non-zero at end of input, which is expected here.
  IFS= read -r -d '' KEY || true
else
  KEY="$1"
fi

# Strip trailing CR/LF exactly as ensure-secret.sh does before it stores a value,
# so the key tested here is the key that would be written.
while :; do
  case "$KEY" in
    *$'\n' | *$'\r') KEY="${KEY%?}" ;;
    *) break ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "gemini key: skipped (empty)"
  exit 4
fi

BASE_URL="${GEMINI_VALIDATE_BASE_URL:-$DEFAULT_BASE_URL}"
NOPROXY=()
if [ "$BASE_URL" != "$DEFAULT_BASE_URL" ]; then
  if ! [[ "$BASE_URL" =~ $LOOPBACK_RE ]]; then
    echo "validate-gemini-key.sh: GEMINI_VALIDATE_BASE_URL may only point at a loopback stub" >&2
    exit 1
  fi
  NOPROXY=(--noproxy '*')
fi

MODEL="${2:-${GEMINI_VALIDATE_MODEL:-$DEFAULT_MODEL}}"
if ! [[ "$MODEL" =~ $MODEL_RE ]]; then
  echo "validate-gemini-key.sh: invalid model name" >&2
  exit 1
fi

RETRY_DELAY="${GEMINI_VALIDATE_RETRY_DELAY_SEC:-2}"

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

FP=$(printf '%s' "$KEY" | sha256_hex | cut -c1-12)

# Every line this script prints goes through here, so the key is scrubbed from all
# of them: a refusal's reason, a 200 reply's block or finish reason, and any cause.
emit() {
  local msg="$1"
  msg="${msg//"$KEY"/[redacted]}"
  echo "gemini key $FP: $msg"
}

# No Gemini key contains whitespace, and a line break cannot travel in a header.
# Whitespace is refused, never trimmed. HTTP drops a header's leading and trailing
# spaces, so Google checks the trimmed key and answers 200, while ensure-secret.sh
# stores the padded value and every consumer reads it unchanged.
case "$KEY" in
  *$'\n'* | *$'\r'*)
    emit "rejected: malformed key (embedded line break)"
    exit 2
    ;;
  *[[:space:]]*)
    emit "rejected: malformed key (whitespace)"
    exit 2
    ;;
esac

command -v curl >/dev/null 2>&1 || { emit "unverified: curl not installed"; exit 3; }

# The first string value of KEY in FILE, or nothing. grep and sed, not jq or
# python3: neither is known to be on the Cuttlefish runners that run the deploy,
# and a missing parser would block every sync without a clear cause. The answers
# needed here are single strings under fixed keys, and the tests pin that shape.
json_string_value() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$2" 2>/dev/null | head -n 1 |
    sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

TMP=$(mktemp -d) || { emit "unverified: could not create a temp directory"; exit 3; }
trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body.json"
REQ="$TMP/request.json"
CURL_ERR="$TMP/curl.err"
printf '%s' '{"contents":[{"role":"user","parts":[{"text":"Reply with the single word: ok"}]}]}' >"$REQ"
URL="$BASE_URL/models/$MODEL:generateContent"

attempt=0
while :; do
  attempt=$((attempt + 1))
  retry=0
  # -q must be the first curl argument. It stops curl reading any .curlrc or curlrc,
  # which could otherwise add a trace that carries the key.
  code=$(printf 'x-goog-api-key: %s\n' "$KEY" | curl -q -sS -o "$BODY" -w '%{http_code}' \
    ${NOPROXY[@]+"${NOPROXY[@]}"} --connect-timeout 5 --max-time 20 \
    -H @- -H 'Content-Type: application/json' \
    --data-binary @"$REQ" "$URL" 2>"$CURL_ERR")
  curl_rc=$?

  if [ "$curl_rc" -ne 0 ]; then
    cause="network error (curl exit $curl_rc)"
    retry=1
  elif ! [[ "$code" =~ ^[0-9][0-9][0-9]$ ]]; then
    # The status must be three digits. Anything else is never printed.
    emit "unverified: unexpected curl output"
    exit 3
  else
    case "$code" in
      200)
        if [ -n "$(json_string_value text "$BODY")" ]; then
          emit "ok"
          exit 0
        fi
        cause=$(json_string_value blockReason "$BODY")
        [ -n "$cause" ] || cause=$(json_string_value finishReason "$BODY")
        [ -n "$cause" ] || cause="no text in reply"
        ;;
      400 | 401 | 403)
        # The API's own reason: the ErrorInfo detail first, then the status, then the message.
        reason=$(json_string_value reason "$BODY")
        [ -n "$reason" ] || reason=$(json_string_value status "$BODY")
        [ -n "$reason" ] || reason=$(json_string_value message "$BODY")
        if [ -n "$reason" ]; then
          # Scrub the key before truncating, so a cut cannot leave part of it behind.
          reason=$(printf '%s' "$reason" | tr '\r\n' '  ')
          reason="${reason//"$KEY"/[redacted]}"
          reason=$(printf '%s' "$reason" | cut -c1-160)
          emit "rejected: $reason"
          exit 2
        fi
        cause="HTTP $code with no reason in the response"
        ;;
      429 | 5??)
        cause="HTTP $code"
        retry=1
        ;;
      *)
        cause="HTTP $code"
        ;;
    esac
  fi

  if [ "$retry" -eq 1 ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$RETRY_DELAY"
    continue
  fi
  emit "unverified: $cause"
  exit 3
done
