#!/bin/bash
# =============================================================================
# Secrets Validation Script
# =============================================================================
# Validates that all required secrets/environment variables are configured
# correctly for production.
#
# Usage:
#   ./scripts/validate-secrets.sh [environment]
#
# Environment: prod
#
# Exit codes:
#   0 - All secrets validated successfully
#   1 - Missing required secrets
#   2 - Invalid environment specified
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ENVIRONMENT="${1:-}"

if [[ -z "$ENVIRONMENT" ]]; then
    echo -e "${RED}Error: Environment not specified${NC}"
    echo "Usage: $0 prod"
    exit 2
fi

# Uppercase environment name (compatible with bash 3.x and zsh)
ENV_UPPER=$(echo "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')

echo "=============================================="
echo "🔐 Secrets Validation: ${ENV_UPPER}"
echo "=============================================="
echo ""

# Track validation status
MISSING_SECRETS=()
WARNINGS=()

# Function to check if a secret exists
check_secret() {
    local name="$1"
    local required="${2:-true}"
    local env_specific="${3:-false}"
    
    local value="${!name:-}"
    
    if [[ -z "$value" ]]; then
        if [[ "$required" == "true" ]]; then
            MISSING_SECRETS+=("$name")
            echo -e "  ${RED}✗${NC} $name - MISSING (required)"
        else
            WARNINGS+=("$name")
            echo -e "  ${YELLOW}⚠${NC} $name - not set (optional)"
        fi
        return 1
    else
        # Mask the value for display
        local masked="${value:0:4}****${value: -4}"
        if [[ ${#value} -lt 10 ]]; then
            masked="****"
        fi
        echo -e "  ${GREEN}✓${NC} $name - configured ($masked)"
        return 0
    fi
}

# Function to check GCP Secret Manager
check_gcp_secret() {
    local secret_name="$1"
    local project_id="$2"
    local required="${3:-true}"
    
    if command -v gcloud &> /dev/null; then
        if gcloud secrets describe "$secret_name" --project="$project_id" &>/dev/null; then
            echo -e "  ${GREEN}✓${NC} GCP Secret: $secret_name (project: $project_id)"
            return 0
        else
            if [[ "$required" == "true" ]]; then
                MISSING_SECRETS+=("GCP:$secret_name")
                echo -e "  ${RED}✗${NC} GCP Secret: $secret_name - MISSING in $project_id"
            else
                WARNINGS+=("GCP:$secret_name")
                echo -e "  ${YELLOW}⚠${NC} GCP Secret: $secret_name - not found (optional)"
            fi
            return 1
        fi
    else
        echo -e "  ${YELLOW}⚠${NC} gcloud CLI not available - skipping GCP secret check for $secret_name"
        return 0
    fi
}

# =============================================================================
# Common Secrets (all environments)
# =============================================================================
echo "📋 Common Secrets"
echo "-------------------------------------------"
check_secret "DATABASE_URL" true
check_secret "NEXTAUTH_SECRET" true
check_secret "AUTH_GOOGLE_ID" true
check_secret "AUTH_GOOGLE_SECRET" true
check_secret "AUTH_FIREBASE_PROJECT_ID" true
check_secret "AUTH_FIREBASE_CLIENT_EMAIL" true
check_secret "AUTH_FIREBASE_PRIVATE_KEY" true
check_secret "ALGOLIA_APP_ID" true
check_secret "ALGOLIA_SEARCH_KEY" true
echo ""

# =============================================================================
# Stripe Secrets (all environments)
# =============================================================================
echo "📋 Stripe Secrets"
echo "-------------------------------------------"
check_secret "STRIPE_SECRET_KEY" true
check_secret "STRIPE_PUBLISHABLE_KEY" true
check_secret "STRIPE_WEBHOOK_SECRET" true
check_secret "STRIPE_PRO_PRICE_ID" true
check_secret "STRIPE_API_ACCESS_PRICE_ID" false
echo ""

# =============================================================================
# Environment-Specific Secrets
# =============================================================================
case "$ENVIRONMENT" in
    prod)
        echo "📋 Production Environment Secrets"
        echo "-------------------------------------------"
        check_secret "VERCEL_TOKEN" true
        check_secret "OPENAI_API_KEY" true
        check_secret "INTERNAL_SERVICE_SECRET" true
        
        echo ""
        echo "📋 GCP Secrets (rosy-clover-477102-t5)"
        echo "-------------------------------------------"
        check_gcp_secret "OPENAI_API_KEY" "rosy-clover-477102-t5" true
        check_gcp_secret "postgres-password" "rosy-clover-477102-t5" true
        check_gcp_secret "INTERNAL_SERVICE_SECRET" "rosy-clover-477102-t5" true
        
        echo ""
        echo "📋 Production-Specific Validations"
        echo "-------------------------------------------"
        # E2E auth should NOT be allowed in production
        if [[ "${ALLOW_E2E_AUTH:-}" == "true" ]]; then
            echo -e "  ${RED}✗${NC} ALLOW_E2E_AUTH=true - SECURITY RISK in production!"
            MISSING_SECRETS+=("ALLOW_E2E_AUTH_SHOULD_BE_FALSE")
        else
            echo -e "  ${GREEN}✓${NC} ALLOW_E2E_AUTH is not set (correct for production)"
        fi
        
        # Check NODE_ENV
        if [[ "${NODE_ENV:-}" == "production" ]]; then
            echo -e "  ${GREEN}✓${NC} NODE_ENV=production"
        else
            echo -e "  ${YELLOW}⚠${NC} NODE_ENV is not 'production' (currently: ${NODE_ENV:-unset})"
            WARNINGS+=("NODE_ENV")
        fi
        
        # INTERNAL_SERVICE_SECRET should not be the default
        if [[ "${INTERNAL_SERVICE_SECRET:-}" == "dev-internal-secret" ]]; then
            echo -e "  ${RED}✗${NC} INTERNAL_SERVICE_SECRET is using default value - SECURITY RISK!"
            MISSING_SECRETS+=("INTERNAL_SERVICE_SECRET_NOT_DEFAULT")
        fi
        ;;
        
    *)
        echo -e "${RED}Error: Unknown environment '$ENVIRONMENT'${NC}"
        echo "Valid environment: prod"
        exit 2
        ;;
esac

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "=============================================="
echo "📊 Validation Summary"
echo "=============================================="

if [[ ${#MISSING_SECRETS[@]} -eq 0 ]]; then
    echo -e "${GREEN}✅ All required secrets are configured!${NC}"
else
    echo -e "${RED}❌ Missing ${#MISSING_SECRETS[@]} required secret(s):${NC}"
    for secret in "${MISSING_SECRETS[@]}"; do
        echo "   - $secret"
    done
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo ""
    echo -e "${YELLOW}⚠️  ${#WARNINGS[@]} warning(s):${NC}"
    for warning in "${WARNINGS[@]}"; do
        echo "   - $warning"
    done
fi

echo ""

# Exit with error if missing required secrets
if [[ ${#MISSING_SECRETS[@]} -gt 0 ]]; then
    echo -e "${RED}Deployment blocked: Fix missing secrets before proceeding.${NC}"
    exit 1
fi

echo -e "${GREEN}Ready for ${ENVIRONMENT} deployment!${NC}"
exit 0
