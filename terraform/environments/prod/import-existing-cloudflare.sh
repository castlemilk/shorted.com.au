#!/usr/bin/env bash
# Idempotent import of pre-existing Cloudflare resources into Terraform state.
#
# Background: the Cloudflare provider in CI was broken from 2026-04-23 to
# 2026-04-25 (api_key vs api_token migration). During that gap, some
# resources were created out-of-band or by an earlier failed apply. After
# fixing auth, terraform apply tried to CREATE colliding resources because
# state didn't know they existed. This script imports them.
#
# Safe to run repeatedly: each block checks state first and is a no-op if
# the resource is already imported.

set -euo pipefail

ZONE_ID="41b338d2d75853d7bedb9a93f1e824f1"
ACCOUNT_ID="2132ccf47ceb5fff234c34d85490470a"

# tf_import <terraform_address> <import_id>
# Skips if the address already exists in state.
# Required variables that have no default and would otherwise prompt
# during terraform import. Read from env (set by the workflow) with safe
# placeholder fallbacks — values do not affect the imported resources.
GRAFANA_AUTH_VALUE="${GRAFANA_AUTH:-placeholder}"

tf_import() {
  local addr="$1"
  local id="$2"
  if terraform state list 2>/dev/null | grep -Fxq "$addr"; then
    echo "  ✓ already in state: $addr"
    return 0
  fi
  echo "  → importing: $addr"
  if terraform import \
       -input=false \
       -var="grafana_auth=${GRAFANA_AUTH_VALUE}" \
       "$addr" "$id"; then
    echo "  ✓ imported: $addr"
  else
    echo "  ⚠ import failed for $addr (continuing)" >&2
    return 0
  fi
}

# tf_state_rm <addr>
# Remove a state entry if it exists, no-op otherwise.
tf_state_rm() {
  local addr="$1"
  if terraform state list 2>/dev/null | grep -Fxq "$addr"; then
    echo "  ✂ removing wrong-addressed state entry: $addr"
    terraform state rm "$addr" || true
  fi
}

echo "=== Cleaning up stale state entries from prior runs ==="
# Earlier import attempts placed some resources at non-indexed addresses
# even though they have count = 1; remove those before re-importing.
tf_state_rm 'module.edge.cloudflare_ruleset.cache_rules'
tf_state_rm 'module.edge.cloudflare_ruleset.rate_limit_api'
tf_state_rm 'module.edge.cloudflare_ruleset.waf_managed'
tf_state_rm 'module.edge.cloudflare_ruleset.app_api_security_skip'
tf_state_rm 'module.edge.cloudflare_ruleset.response_header_transforms'
tf_state_rm 'module.edge.cloudflare_workers_script.prewarm'
# DNS frontend was deleted+recreated, so strip any stale [0] entry.
tf_state_rm 'module.edge.cloudflare_record.frontend[0]'

echo "=== Importing pre-existing Cloudflare resources ==="

# DNS records (count = create_frontend_records ? 1 : 0 → [0] index)
tf_import 'module.edge.cloudflare_record.frontend[0]' "${ZONE_ID}/003b51b8b5a39630b09c5cb663bba1b9"
tf_import 'module.edge.cloudflare_record.www[0]'      "${ZONE_ID}/8f2b411d8c3bf24cb2c7e603c4fc0bcd"
tf_import 'module.edge.cloudflare_record.api[0]'      "${ZONE_ID}/91cf9d64108ee15cf2a230c5aab8d909"

# Workers KV namespace (no count → no index)
tf_import 'module.edge.cloudflare_workers_kv_namespace.edge_cache' "${ACCOUNT_ID}/e08015a2c6324c7b8b3faa810d5b0c73"

# Zone-level rulesets — all have count = 1, so [0] index required.
# Provider v4 import format: zone/<zone_id>/<ruleset_id> (singular).
# All four rulesets ARE present at Cloudflare and must be imported on
# every run; previous comment claiming cache_rules + rate_limit_api
# were deleted was wrong — verified live via Cloudflare API. Without
# these imports, terraform apply tries to CREATE colliding rulesets
# and fails with "A similar configuration with rules already exists".
tf_import 'module.edge.cloudflare_ruleset.waf_managed[0]'     "zone/${ZONE_ID}/ea95ef9d9d1547d58e2ea004c832f83a"
tf_import 'module.edge.cloudflare_ruleset.app_api_security_skip[0]' "zone/${ZONE_ID}/dd8d8eba62d44f7f9362e5553b2b57f8"
tf_import 'module.edge.cloudflare_ruleset.cache_rules[0]'     "zone/${ZONE_ID}/debd8a1c7c3c412e89a344801cc57ae3"
tf_import 'module.edge.cloudflare_ruleset.response_header_transforms[0]' "zone/${ZONE_ID}/048851bae4b3489aafb5744e6392906f"
tf_import 'module.edge.cloudflare_ruleset.rate_limit_api[0]'  "zone/${ZONE_ID}/f86ec850c6194005b04b6a8cc8d8dfe5"

# Workers scripts: edge_cache (no count), prewarm (count = 1, has [0])
tf_import 'module.edge.cloudflare_workers_script.edge_cache' "${ACCOUNT_ID}/shorted-edge-cache"
tf_import 'module.edge.cloudflare_workers_script.prewarm[0]' "${ACCOUNT_ID}/shorted-edge-cache-prewarm"

# Workers route (no count → no index)
tf_import 'module.edge.cloudflare_workers_route.api' "${ZONE_ID}/8d6a2484aeb244d4b55d9bb67c6c0bfc"

echo "=== Import sweep complete ==="
