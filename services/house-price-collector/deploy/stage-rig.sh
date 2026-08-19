#!/usr/bin/env bash
# stage-rig.sh — build and stage the residential-rig deploy, with drift checks.
#
# The rig binary (~/bin/house-price-collector) and the staged wrappers
# (~/.shorted-housing-crawl-deploy/) are a HAND deploy, invisible to CI. On
# 2026-08-15 the binary was found 4h17m older than the fix it was assumed to
# run. This script makes the hand deploy repeatable and checkable:
#
#   stage-rig.sh            build from a CLEAN checkout at origin/main, install
#                           the binary + wrappers, install the playwright
#                           driver, print the deployed revision.
#   stage-rig.sh --check    read-only: report binary-revision and wrapper drift
#                           against origin/main; exit 0 = current, 1 = drifted.
#
# Refuses to stage a dirty tree or a non-origin/main HEAD unless
# STAGE_ALLOW_DIRTY=1 (for deliberately testing a branch build on the rig).
set -euo pipefail

STAGE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAGE_SERVICES="$STAGE_REPO/services"
STAGE_DEPLOY_SRC="$STAGE_SERVICES/house-price-collector/deploy"
STAGE_BIN_DEST="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
STAGE_DIR="${HOUSING_CRAWL_STAGE_DIR:-$HOME/.shorted-housing-crawl-deploy}"
STAGE_WRAPPERS=(housing-crawl-common.sh run-housing-delta.sh run-housing-full.sh run-housing-rescan.sh)

# rig_find_go mirrors hc_find_go in housing-crawl-common.sh: resolve go by
# probing explicit candidates, not just PATH, so a non-interactive caller (or a
# shell without Homebrew's bin on PATH) does not silently report "unknown".
rig_find_go() {
	local candidates=() c
	[[ -n "${HOUSING_GO_BIN:-}" ]] && candidates+=("$HOUSING_GO_BIN")
	c="$(command -v go 2>/dev/null || true)"
	[[ -n "$c" ]] && candidates+=("$c")
	candidates+=(/opt/homebrew/bin/go /usr/local/go/bin/go /usr/local/bin/go)
	for c in "${candidates[@]}"; do
		[[ -x "$c" ]] && { echo "$c"; return 0; }
	done
	return 1
}

# rig_binary_revision prints the first 12 chars of a binary's vcs.revision, or
# "unknown". Same parse as hc_log_binary_provenance — keep them in agreement.
rig_binary_revision() {
	local bin="$1" rev="" gobin
	gobin="$(rig_find_go || true)"
	if [[ -n "$gobin" ]]; then
		rev="$("$gobin" version -m "$bin" 2>/dev/null \
			| /usr/bin/awk '$1 == "build" && $2 ~ /^vcs\.revision=/ { sub("vcs.revision=", "", $2); print substr($2, 1, 12); exit }')"
	fi
	echo "${rev:-unknown}"
}

# rig_wrapper_drift diffs each STAGE_WRAPPERS file between a repo dir ($1) and
# a staged dir ($2). Prints each drifted/missing file; returns 1 if any drift.
rig_wrapper_drift() {
	local repo_dir="$1" staged_dir="$2" drifted=0 f
	for f in "${STAGE_WRAPPERS[@]}"; do
		if [[ ! -f "$staged_dir/$f" ]]; then
			echo "MISSING: $f (not staged)"
			drifted=1
		elif ! /usr/bin/diff -q "$repo_dir/$f" "$staged_dir/$f" >/dev/null 2>&1; then
			echo "DRIFTED: $f"
			drifted=1
		fi
	done
	return "$drifted"
}

# rig_webhook_state reports whether hc_alert has anywhere to push. Alerting was
# found completely dark on 2026-08-18 (no WEBHOOK entry in the rig env file at
# all), and no command told anyone. `--check` is the one thing an operator runs
# during an incident, so it must answer "will an alert actually reach me?".
# READ-ONLY: it greps the env file, never writes it. Prints the STATE, never the
# secret — --check output gets pasted into incident threads.
rig_webhook_state() {
	local envfile="${HOUSING_CRAWL_ENV:-$HOME/.shorted-housing-crawl.env}"
	local var
	for var in CRAWL_ALERT_WEBHOOK CRAWL_FRESHNESS_WEBHOOK; do
		if [[ -n "${!var:-}" ]] || { [[ -f "$envfile" ]] && /usr/bin/grep -Eq "^[[:space:]]*(export[[:space:]]+)?${var}=[^[:space:]]" "$envfile"; }; then
			echo "alerting: CONFIGURED ($var set)"
			return 0
		fi
	done
	echo "alerting: NOT CONFIGURED — hc_alert can only raise a desktop notification."
	echo "          Set CRAWL_ALERT_WEBHOOK (or CRAWL_FRESHNESS_WEBHOOK) in $envfile"
	return 0
}

stage_check() {
	git -C "$STAGE_REPO" fetch origin main --quiet
	local want got rc=0
	want="$(git -C "$STAGE_REPO" rev-parse --short=12 origin/main)"
	got="$(rig_binary_revision "$STAGE_BIN_DEST")"
	if [[ "$got" == "$want" ]]; then
		echo "binary: CURRENT ($got == origin/main)"
	else
		echo "binary: DRIFTED (deployed=$got origin/main=$want)"
		rc=1
	fi
	if rig_wrapper_drift "$STAGE_DEPLOY_SRC" "$STAGE_DIR"; then
		echo "wrappers: CURRENT"
	else
		rc=1
	fi
	# Reported, not enforced: the exit code stays a pure DRIFT signal (0 current /
	# 1 drifted) so scripts reading it keep their meaning. A dark alert channel is
	# an operator decision, so it is surfaced loudly and left to the human.
	rig_webhook_state
	return "$rc"
}

stage_install() {
	if [[ "${STAGE_ALLOW_DIRTY:-0}" != "1" ]]; then
		if [[ -n "$(git -C "$STAGE_REPO" status --porcelain)" ]]; then
			echo "refusing to stage a DIRTY tree (set STAGE_ALLOW_DIRTY=1 to override)" >&2
			exit 1
		fi
		git -C "$STAGE_REPO" fetch origin main --quiet
		local head main_sha
		head="$(git -C "$STAGE_REPO" rev-parse HEAD)"
		main_sha="$(git -C "$STAGE_REPO" rev-parse origin/main)"
		if [[ "$head" != "$main_sha" ]]; then
			echo "refusing to stage: HEAD is not origin/main (set STAGE_ALLOW_DIRTY=1 to deploy a branch build deliberately)" >&2
			exit 1
		fi
	fi
	mkdir -p "$(dirname "$STAGE_BIN_DEST")" "$STAGE_DIR"
	(cd "$STAGE_SERVICES" && GOWORK=off go build -o "$STAGE_BIN_DEST" ./house-price-collector/)
	local f
	for f in "${STAGE_WRAPPERS[@]}"; do
		/bin/cp "$STAGE_DEPLOY_SRC/$f" "$STAGE_DIR/$f"
		/bin/chmod +x "$STAGE_DIR/$f"
	done
	# Keep the driver in step with the freshly-built binary's playwright pin,
	# in the sweep-proof directory the wrappers configure.
	CRAWL_PW_DRIVER_DIR="${CRAWL_PW_DRIVER_DIR:-$HOME/.shorted-housing-crawl/pw-driver}" \
		"$STAGE_BIN_DEST" -mode install-driver
	echo "staged: $STAGE_BIN_DEST (vcs.revision=$(rig_binary_revision "$STAGE_BIN_DEST")) + ${#STAGE_WRAPPERS[@]} wrappers → $STAGE_DIR"
	echo "next: ~/bin/house-price-collector -mode warmcheck"
}

# Only run when executed, so the test suite can source the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	case "${1:-install}" in
	--check) stage_check ;;
	install | "") stage_install ;;
	*)
		echo "usage: stage-rig.sh [--check]" >&2
		exit 2
		;;
	esac
fi
