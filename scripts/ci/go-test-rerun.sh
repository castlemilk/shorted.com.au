#!/usr/bin/env bash
# go test with one rerun of the packages that failed.
#
# usage: scripts/ci/go-test-rerun.sh [go test args...]   (run from the module directory)
#
# A package that fails is run once more on its own. A package that fails twice fails
# the job, as before. A package that passes on the rerun is a flake: the job passes,
# and the package and its failed tests are printed as a workflow warning, so a flake
# is visible on the run page and never silent. Measured on the collector package over
# 2026-11-05 and 06: four deploy-gating runs failed on four different tests of one
# package, each passing locally and on the runs before and after (a stray descriptor
# close, since fixed, and the runner's own timing). A real regression fails both
# runs; a rerun masks only a failure that does not reproduce.
set -uo pipefail
args=("$@")
out=$(mktemp)
go test "${args[@]}" 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
if [ "$status" -eq 0 ]; then
  rm -f "$out"
  exit 0
fi
# Packages the first run failed (a `FAIL<tab>pkg` line each). A build failure has no
# such line and fails as it is.
failed=$(grep -E '^FAIL[[:space:]]+[^[:space:]]+' "$out" | awk '{print $2}' | sort -u)
if [ -z "$failed" ]; then
  rm -f "$out"
  exit "$status"
fi
tests=$(grep -E '^\s*--- FAIL: ' "$out" | awk '{print $3}' | sort -u | tr '\n' ' ')
echo
echo "::warning::go test: rerunning failed package(s) once: $(echo "$failed" | tr '\n' ' ')(failed tests: ${tests})"
rm -f "$out"
# The rerun keeps every flag but the package patterns, which are the failed packages.
rerun=()
for a in "${args[@]}"; do
  case "$a" in ./...|./*|.) ;; *) rerun+=("$a") ;; esac
done
out2=$(mktemp)
# shellcheck disable=SC2086
go test -count=1 "${rerun[@]}" $failed 2>&1 | tee "$out2"
status2=${PIPESTATUS[0]}
still=$(grep -E '^FAIL[[:space:]]+[^[:space:]]+' "$out2" | awk '{print $2}' | sort -u | tr '\n' ' ')
rm -f "$out2"
if [ "$status2" -eq 0 ]; then
  echo "::warning::go test: the rerun passed; the first run's failure was a flake in: $(echo "$failed" | tr '\n' ' ')(tests: ${tests})"
  exit 0
fi
echo "::error::go test: failed on both runs: ${still}"
exit 1
