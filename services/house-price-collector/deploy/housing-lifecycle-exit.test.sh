#!/usr/bin/env bash
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/housing-lifecycle-exit.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

FAKE_COLLECTOR="$TMP_ROOT/fake-collector"
FAKE_HOME="$TMP_ROOT/home"
mkdir -p "$FAKE_HOME"

apply_fake() {
	local agent_rc="$1"
	local enqueue_rc="${2:-0}"
	cat >"$FAKE_COLLECTOR" <<EOF
#!/usr/bin/env bash
case "\${2:-}" in
agent)
	echo "[agent] done: processed 0 job(s)"
	exit $agent_rc
	;;
enqueue)
	exit $enqueue_rc
	;;
freshness)
	exit 0
	;;
*)
	exit 0
	;;
esac
EOF
	chmod +x "$FAKE_COLLECTOR"
}

run_expect_rc() {
	local want="$1"
	shift
	set +e
	"$@"
	local got=$?
	set -e
	if [[ "$got" -ne "$want" ]]; then
		echo "FAIL: expected rc=$want, got rc=$got: $*" >&2
		return 1
	fi
}

test_common_preserves_fatal_zero_processed() {
	apply_fake 7 0
	run_expect_rc 7 bash -c '
		set -uo pipefail
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=1
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$TMP_ROOT/common.log"
}

test_common_allows_legitimate_empty_success() {
	apply_fake 0 0
	run_expect_rc 0 bash -c '
		set -uo pipefail
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=1
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$TMP_ROOT/common-empty.log"
}

test_common_preserves_generic_failure() {
	apply_fake 9 0
	run_expect_rc 9 bash -c '
		set -uo pipefail
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=1
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$TMP_ROOT/common-generic.log"
}

# rc=8 is the "crawl environment broken" signal (a missing Playwright driver).
# The generic failure path propagates the code correctly, but the LOG LINE is the
# artefact a human actually reads during an outage — in the 2026-08-13 stoppage a
# misleading one ("Chrome unusable") cost two days and 500/500 stale suburbs. So
# rc=8 must name the driver and the reinstall command, not a generic failure.
test_common_names_the_driver_fix_on_broken_env() {
	local log="$TMP_ROOT/common-brokenenv.log"
	apply_fake 8 0
	run_expect_rc 8 bash -c '
		set -uo pipefail
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=1
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$log" || return 1
	if ! /usr/bin/grep -qi "driver" "$log"; then
		echo "FAIL: rc=8 drain log does not mention the driver: $log" >&2
		return 1
	fi
	if ! /usr/bin/grep -q "cmd/playwright" "$log"; then
		echo "FAIL: rc=8 drain log does not carry the reinstall command: $log" >&2
		return 1
	fi
	if /usr/bin/grep -qi "chrome unusable" "$log"; then
		echo "FAIL: rc=8 drain log still blames Chrome: $log" >&2
		return 1
	fi
}

test_wrapper_preserves_fatal_zero_processed() {
	local wrapper="$1"
	apply_fake 7 0
	run_expect_rc 7 env \
		HOME="$FAKE_HOME" \
		DATABASE_URL="postgresql://example.invalid/test" \
		CRAWL_CDP_URL="http://127.0.0.1:9222" \
		HOUSING_CRAWL_BIN="$FAKE_COLLECTOR" \
		HOUSING_CRAWL_LOG="$TMP_ROOT/${wrapper}.log" \
		HOUSING_CRAWL_LOCKDIR="$TMP_ROOT/${wrapper}.lock" \
		CRAWL_DRAIN_MAX_ROUNDS=1 \
		bash "$DIR/$wrapper"
}

test_wrapper_preserves_enqueue_failure() {
	local wrapper="$1"
	apply_fake 0 7
	run_expect_rc 7 env \
		HOME="$FAKE_HOME" \
		DATABASE_URL="postgresql://example.invalid/test" \
		CRAWL_CDP_URL="http://127.0.0.1:9222" \
		HOUSING_CRAWL_BIN="$FAKE_COLLECTOR" \
		HOUSING_CRAWL_LOG="$TMP_ROOT/${wrapper}-enqueue.log" \
		HOUSING_CRAWL_LOCKDIR="$TMP_ROOT/${wrapper}-enqueue.lock" \
		CRAWL_DRAIN_MAX_ROUNDS=1 \
		bash "$DIR/$wrapper"
}

failures=0
test_common_preserves_fatal_zero_processed || failures=$((failures + 1))
test_common_allows_legitimate_empty_success || failures=$((failures + 1))
test_common_preserves_generic_failure || failures=$((failures + 1))
test_common_names_the_driver_fix_on_broken_env || failures=$((failures + 1))
test_wrapper_preserves_fatal_zero_processed run-housing-delta.sh || failures=$((failures + 1))
test_wrapper_preserves_fatal_zero_processed run-housing-full.sh || failures=$((failures + 1))
test_wrapper_preserves_enqueue_failure run-housing-delta.sh || failures=$((failures + 1))
test_wrapper_preserves_enqueue_failure run-housing-full.sh || failures=$((failures + 1))

if ((failures > 0)); then
	echo "housing lifecycle exit regression: $failures failure(s)" >&2
	exit 1
fi
echo "housing lifecycle exit regression: PASS"
