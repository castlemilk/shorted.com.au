#!/usr/bin/env bash
#
# One-shot fix: import the two Cloudflare rulesets that already exist
# on the shorted.com.au zone but aren't tracked in Terraform state.
# Run this once from your local machine with ADC pointed at the
# rosy-clover-477102-t5 GCP project (`gcloud auth application-default
# login --account=ben@shorted.com.au`).
#
# After this completes successfully, `terraform-apply` in CI will
# stop failing on the "ruleset already exists" error.
#
# Resources being imported:
#   - module.edge.cloudflare_ruleset.cache_rules[0]
#       Phase: http_request_cache_settings
#       ID:    debd8a1c7c3c412e89a344801cc57ae3
#       Name:  shorted-cache-rules
#   - module.edge.cloudflare_ruleset.rate_limit_api[0]
#       Phase: http_ratelimit
#       ID:    f86ec850c6194005b04b6a8cc8d8dfe5
#       Name:  shorted-rate-limit

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$REPO_ROOT/terraform/environments/prod"
ZONE_ID="41b338d2d75853d7bedb9a93f1e824f1"
CACHE_RULESET_ID="debd8a1c7c3c412e89a344801cc57ae3"
RATE_LIMIT_RULESET_ID="f86ec850c6194005b04b6a8cc8d8dfe5"

# Load Cloudflare token from repo-root .env (TF_VAR_cloudflare_api_token).
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

if [ -z "${TF_VAR_cloudflare_api_token:-}" ]; then
  echo "ERROR: TF_VAR_cloudflare_api_token not set. Put it in $REPO_ROOT/.env"
  exit 1
fi

cd "$ENV_DIR"

echo "==> terraform init -reconfigure"
terraform init -reconfigure

echo ""
echo "==> Importing cache_rules"
terraform import \
  'module.edge.cloudflare_ruleset.cache_rules[0]' \
  "zone/${ZONE_ID}/${CACHE_RULESET_ID}"

echo ""
echo "==> Importing rate_limit_api"
terraform import \
  'module.edge.cloudflare_ruleset.rate_limit_api[0]' \
  "zone/${ZONE_ID}/${RATE_LIMIT_RULESET_ID}"

echo ""
echo "==> Done. Next: kick off terraform-apply via:"
echo "    gh workflow run terraform-deploy.yml --ref main -f environment=prod"
