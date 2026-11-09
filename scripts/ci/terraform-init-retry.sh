#!/usr/bin/env bash
# terraform init, retried while a provider download fails on the network.
#
# usage: scripts/ci/terraform-init-retry.sh [terraform init args...]   (run from the root module)
#
# The registry serves the Cloudflare provider from GitHub release downloads, so a
# GitHub outage fails every deploy at init, whatever the change. On 2026-11-09
# (GitHub: "increased timeouts due to surge in anonymous users", ~06:00-08:15 UTC)
# init failed with "Error while installing cloudflare/cloudflare v5.26.0: github.com:
# bad response code: 504" on run after run, while some downloads still succeeded.
#
# Only a failure whose output names a download or network error is retried, after
# 30, 60, 120 and 240 s (TF_INIT_ATTEMPTS, TF_INIT_RETRY_DELAY scale this). Anything
# else (a backend, credential or configuration error) fails on the first attempt, as
# before. Every retry is printed as a workflow warning, so it is never silent.
set -uo pipefail
attempts="${TF_INIT_ATTEMPTS:-5}"
delay="${TF_INIT_RETRY_DELAY:-30}"
transient='bad response code: 5[0-9][0-9]|could not query provider registry|context deadline exceeded|Client.Timeout|TLS handshake timeout|i/o timeout|connection reset by peer|connection refused|no such host|unexpected EOF'

for ((attempt = 1; ; attempt++)); do
  out=$(mktemp)
  terraform init -input=false "$@" 2>&1 | tee "$out"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then
    rm -f "$out"
    [ "$attempt" -gt 1 ] && echo "::warning::terraform init: succeeded on attempt ${attempt} of ${attempts}"
    exit 0
  fi
  reason=$(grep -E -o -m1 "$transient" "$out")
  rm -f "$out"
  if [ -z "$reason" ]; then
    exit "$status"
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::terraform init: still failing after ${attempts} attempts (last: ${reason})"
    exit "$status"
  fi
  echo "::warning::terraform init: attempt ${attempt} of ${attempts} failed (${reason}); retrying in ${delay}s"
  sleep "$delay"
  delay=$((delay * 2))
done
