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
tf_import() {
  local addr="$1"
  local id="$2"
  if terraform state list 2>/dev/null | grep -Fxq "$addr"; then
    echo "  ✓ already in state: $addr"
    return 0
  fi
  echo "  → importing: $addr"
  if terraform import "$addr" "$id"; then
    echo "  ✓ imported: $addr"
  else
    echo "  ⚠ import failed for $addr (continuing)" >&2
    return 0
  fi
}

echo "=== Importing pre-existing Cloudflare resources ==="

# DNS records (count = create_frontend_records ? 1 : 0 → [0] index)
tf_import 'module.edge.cloudflare_record.frontend[0]' "${ZONE_ID}/452eb64eb1941f9c231c5b1140b029cc"
tf_import 'module.edge.cloudflare_record.www[0]'      "${ZONE_ID}/8f2b411d8c3bf24cb2c7e603c4fc0bcd"
tf_import 'module.edge.cloudflare_record.api[0]'      "${ZONE_ID}/91cf9d64108ee15cf2a230c5aab8d909"

# Workers KV namespace
tf_import 'module.edge.cloudflare_workers_kv_namespace.edge_cache' "${ACCOUNT_ID}/e08015a2c6324c7b8b3faa810d5b0c73"

# Zone-level rulesets (provider v4 import format: zones/<zone_id>/<ruleset_id>)
tf_import 'module.edge.cloudflare_ruleset.cache_rules'    "zones/${ZONE_ID}/41ee35a0a79e423885b0039e1fd2e7e6"
tf_import 'module.edge.cloudflare_ruleset.rate_limit_api' "zones/${ZONE_ID}/8fb6b309716c4e01ab70f7962f6bd061"
tf_import 'module.edge.cloudflare_ruleset.waf_managed'    "zones/${ZONE_ID}/ea95ef9d9d1547d58e2ea004c832f83a"

# Workers scripts and routes
tf_import 'module.edge.cloudflare_workers_script.edge_cache'        "${ACCOUNT_ID}/shorted-edge-cache"
tf_import 'module.edge.cloudflare_workers_script.prewarm'           "${ACCOUNT_ID}/shorted-edge-cache-prewarm"
tf_import 'module.edge.cloudflare_workers_route.api'                "${ZONE_ID}/8d6a2484aeb244d4b55d9bb67c6c0bfc"

echo "=== Import sweep complete ==="
