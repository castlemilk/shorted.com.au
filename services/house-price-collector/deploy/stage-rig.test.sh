#!/usr/bin/env bash
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/stage-rig-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

failures=0

# Sourcing the script must define its functions without running a deploy.
test_sourceable() {
	bash -c 'source "$1/stage-rig.sh" && declare -F rig_binary_revision >/dev/null && declare -F rig_wrapper_drift >/dev/null' _ "$DIR"
	if [[ $? -ne 0 ]]; then
		echo "FAIL: stage-rig.sh is not sourceable / functions missing" >&2
		return 1
	fi
}

test_rig_binary_revision_parses_go_output() {
	local tools="$TMP_ROOT/tools"
	mkdir -p "$tools"
	cat >"$tools/go" <<'EOF'
#!/usr/bin/env bash
printf '\tbuild\tvcs.revision=1a4b73baf365cdb305336ae5323062411169a7c9\n'
EOF
	chmod +x "$tools/go"
	local got
	got="$(bash -c 'PATH="$2:$PATH"; source "$1/stage-rig.sh"; rig_binary_revision /any/binary' _ "$DIR" "$tools")"
	if [[ "$got" != "1a4b73baf365" ]]; then
		echo "FAIL: rig_binary_revision returned '$got', want 1a4b73baf365" >&2
		return 1
	fi
}

test_rig_wrapper_drift_reports_changed_file() {
	local repo_side="$TMP_ROOT/repo" staged_side="$TMP_ROOT/staged"
	mkdir -p "$repo_side" "$staged_side"
	echo "same" >"$repo_side/a.sh"; echo "same" >"$staged_side/a.sh"
	echo "new"  >"$repo_side/b.sh"; echo "old"  >"$staged_side/b.sh"
	local out
	out="$(bash -c 'source "$1/stage-rig.sh"; STAGE_WRAPPERS=(a.sh b.sh); rig_wrapper_drift "$2" "$3"' _ "$DIR" "$repo_side" "$staged_side")"
	local rc=$?
	if [[ $rc -eq 0 ]]; then
		echo "FAIL: drift not detected (rc=0)" >&2
		return 1
	fi
	if ! grep -q "b.sh" <<<"$out"; then
		echo "FAIL: drift output does not name b.sh: $out" >&2
		return 1
	fi
	if grep -q "a.sh" <<<"$out"; then
		echo "FAIL: unchanged a.sh reported as drifted: $out" >&2
		return 1
	fi
}

# `stage-rig.sh --check` is the ONE command an operator runs during an incident,
# so it must answer "will an alert actually reach me?" — verified 2026-08-18 the
# rig had no webhook set at all, and nothing anywhere said so. Report the state
# from the env file the wrappers read, without touching the live rig config.
test_webhook_state_reported_when_missing() {
	local envfile="$TMP_ROOT/no-webhook.env"
	printf 'DATABASE_URL=postgresql://example.invalid/x\n' >"$envfile"
	local out
	out="$(bash -c 'source "$1/stage-rig.sh"; HOUSING_CRAWL_ENV="$2" rig_webhook_state' _ "$DIR" "$envfile" 2>&1)"
	if ! grep -q "NOT CONFIGURED" <<<"$out"; then
		echo "FAIL: missing webhook not reported as NOT CONFIGURED: $out" >&2
		return 1
	fi
	if ! grep -q "CRAWL_ALERT_WEBHOOK" <<<"$out"; then
		echo "FAIL: webhook report does not name the variable to set: $out" >&2
		return 1
	fi
}

test_webhook_state_reported_when_present() {
	local envfile="$TMP_ROOT/with-webhook.env"
	printf 'CRAWL_ALERT_WEBHOOK=https://hooks.example.invalid/T/B\n' >"$envfile"
	local out
	out="$(bash -c 'source "$1/stage-rig.sh"; HOUSING_CRAWL_ENV="$2" rig_webhook_state' _ "$DIR" "$envfile" 2>&1)"
	if ! grep -q "CONFIGURED" <<<"$out" || grep -q "NOT CONFIGURED" <<<"$out"; then
		echo "FAIL: configured webhook not reported as CONFIGURED: $out" >&2
		return 1
	fi
	# The secret itself must never be echoed into an incident transcript.
	if grep -q "hooks.example.invalid" <<<"$out"; then
		echo "FAIL: --check leaked the webhook URL: $out" >&2
		return 1
	fi
}

# --check must actually CALL the reporter, not merely define it.
test_check_surfaces_webhook_state() {
	if ! grep -q "rig_webhook_state" <<<"$(sed -n '/^stage_check()/,/^}/p' "$DIR/stage-rig.sh")"; then
		echo "FAIL: stage_check does not report webhook configuration" >&2
		return 1
	fi
}

test_sourceable || failures=$((failures + 1))
test_webhook_state_reported_when_missing || failures=$((failures + 1))
test_webhook_state_reported_when_present || failures=$((failures + 1))
test_check_surfaces_webhook_state || failures=$((failures + 1))
test_rig_binary_revision_parses_go_output || failures=$((failures + 1))
test_rig_wrapper_drift_reports_changed_file || failures=$((failures + 1))

if ((failures > 0)); then
	echo "stage-rig regression: $failures failure(s)" >&2
	exit 1
fi
echo "stage-rig regression: PASS"
