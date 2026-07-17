#!/usr/bin/env bash
# Android PHONE crawl node — drive a real Android phone's Chrome over adb+CDP,
# instead of the Mac's Chrome. Same collector, same brandbrain queue; the phone
# just IS the browser.
#
# Why this exists: an in-app WebView (WKWebView / Android WebView) does a
# PROGRAMMATIC navigation, which Kasada detects and serves an ~800-byte KPSDK
# stub (verified). REAL Chrome doing a NATIVE navigation clears Kasada — that's
# the whole Mac trick. This drives the phone's REAL Chrome the same way the Mac
# runner drives the Mac's, so it also inherits the phone's distinct DEVICE
# FINGERPRINT and (on mobile data) a different IP — the reason a phone on the same
# WiFi wasn't blocked when the Mac was. Multiple phones + the Mac all drain the
# one brandbrain queue via SKIP LOCKED, so a block on one device never stops the
# others.
#
# ONE-TIME phone setup:
#   1. Settings → About phone → tap "Build number" 7× → Developer options on.
#   2. Developer options → enable "USB debugging".
#   3. Plug the phone into the Mac via USB; approve the "Allow USB debugging?"
#      prompt on the phone.
#   4. Install Chrome on the phone (the crawl needs Chrome specifically — its
#      DevTools socket is `chrome_devtools_remote`).
#
# Then just run this. It opens REA in the phone's Chrome (native nav → clears
# Kasada), forwards Chrome's DevTools socket to a local port, proves the session
# is warm, and runs the collector against it.
set -uo pipefail

ENV_FILE="${HOUSING_CRAWL_ENV:-$HOME/.shorted-housing-crawl.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (put it in $ENV_FILE)}"

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
command -v "$ADB" >/dev/null 2>&1 || ADB="adb"
CDP_PORT="${ANDROID_CDP_PORT:-9224}"
export CRAWL_CDP_URL="http://localhost:${CDP_PORT}"
export CRAWL_DRY_RUN="${CRAWL_DRY_RUN:-false}"
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-120}"
export BRANDBRAIN_AGENT_URL="${BRANDBRAIN_AGENT_URL:-https://api.brandbrain.dev}"
# Name this rig distinctly in the queue so multi-device runs are legible.
DEVID="$("$ADB" get-serialno 2>/dev/null | tr -d '[:space:]')"
export CRAWL_AGENT_ID="${CRAWL_AGENT_ID:-housing-android-${DEVID:-phone}}"

BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-android.log}"
REA_URL="https://www.realestate.com.au/"

echo "=== $(date -u +%FT%TZ) android phone node (device=${DEVID:-?}) ===" >>"$LOG"

# 1. A device must be attached + authorized.
state="$("$ADB" get-state 2>/dev/null)"
if [[ "$state" != "device" ]]; then
	echo "no authorized Android device (adb get-state='$state'). Plug in the phone, enable USB debugging, approve the prompt." | tee -a "$LOG"
	exit 4
fi

# 2. Open REA in the phone's REAL Chrome — a native VIEW navigation, which is
#    what clears Kasada (a programmatic WebView load does NOT). Force Chrome as
#    the handler so a non-Chrome default browser doesn't swallow it.
echo "$(date -u +%FT%TZ) opening REA in phone Chrome to warm Kasada" >>"$LOG"
"$ADB" shell am start -a android.intent.action.VIEW -d "$REA_URL" \
	com.android.chrome >>"$LOG" 2>&1 ||
	"$ADB" shell am start -a android.intent.action.VIEW -d "$REA_URL" >>"$LOG" 2>&1
sleep 12

# 3. Forward Chrome's on-device DevTools socket to a local TCP port for CDP.
"$ADB" forward "tcp:${CDP_PORT}" localabstract:chrome_devtools_remote >>"$LOG" 2>&1
if ! /usr/bin/curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null; then
	echo "phone Chrome DevTools not reachable at :${CDP_PORT} — is Chrome running on the phone with USB debugging on?" | tee -a "$LOG"
	exit 4
fi
echo "$(date -u +%FT%TZ) phone Chrome CDP up: $(/usr/bin/curl -sf http://localhost:${CDP_PORT}/json/version | tr -d '\n' | cut -c1-120)" >>"$LOG"

# 4. Prove REA's Kasada actually cleared on the phone (a reachable CDP port is
#    not the same as a warm REA session) before spending a real run.
"$BIN" -mode warmcheck >>"$LOG" 2>&1
rc=$?
if [[ "$rc" -ne 0 ]]; then
	echo "phone REA warmcheck failed (rc=$rc) — REA may be serving a Kasada stub to the phone's Chrome. Tap the REA tab on the phone to complete any challenge, then re-run." | tee -a "$LOG"
	exit 5
fi
echo "$(date -u +%FT%TZ) phone REA warm — draining the queue via the phone's Chrome" >>"$LOG"

# 5. Warm — drain the shared brandbrain queue through the phone's Chrome. The
#    phone fans suburbs out alongside the Mac + any other devices.
if [[ "${CRAWL_SKIP_ENQUEUE:-false}" != "true" ]]; then
	"$BIN" -mode enqueue >>"$LOG" 2>&1
fi
"$BIN" -mode agent >>"$LOG" 2>&1
rc_agent=$?
echo "$(date -u +%FT%TZ) android agent rc=$rc_agent" >>"$LOG"
exit "$rc_agent"
