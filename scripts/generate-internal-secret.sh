#!/bin/bash
# Generate and configure internal service secret for webhook authentication
#
# This secret is used for server-to-server authentication between:
# - Vercel (Next.js webhook handler/server actions) -> Cloud Run (Go backend)
#
# Usage:
#   ./scripts/generate-internal-secret.sh                # Just generate
#   ./scripts/generate-internal-secret.sh --gcp          # Create in GCP dev
#   ./scripts/generate-internal-secret.sh --gcp --prod   # Create in GCP prod
#   ./scripts/generate-internal-secret.sh --all          # Full setup (GitHub + both GCP projects)
#
# Requirements:
# - gcloud CLI authenticated
# - gh CLI authenticated (for --all)

set -e

DEV_PROJECT="shorted-dev-aba5688f"
PROD_PROJECT="rosy-clover-477102-t5"

# Generate a 32-byte random secret, base64 encoded
SECRET=$(openssl rand -base64 32)

echo "=============================================="
echo "🔐 Internal Service Secret Generator"
echo "=============================================="
echo ""
echo "Generated INTERNAL_SERVICE_SECRET:"
echo "  $SECRET"
echo ""

create_gcp_secret() {
    local project_id="$1"
    local env_name="$2"
    
    echo "📦 Setting up secret in GCP ($env_name: $project_id)..."
    
    if gcloud secrets describe INTERNAL_SERVICE_SECRET --project="$project_id" &>/dev/null; then
        echo "   Secret exists, adding new version..."
        echo -n "$SECRET" | gcloud secrets versions add INTERNAL_SERVICE_SECRET \
            --project="$project_id" \
            --data-file=-
    else
        echo "   Creating new secret..."
        echo -n "$SECRET" | gcloud secrets create INTERNAL_SERVICE_SECRET \
            --project="$project_id" \
            --data-file=- \
            --replication-policy="automatic"
    fi
    
    echo "   ✅ GCP Secret Manager ($env_name) configured"
}

# Parse arguments
CREATE_DEV_GCP=false
CREATE_PROD_GCP=false
CREATE_GITHUB=false

for arg in "$@"; do
    case $arg in
        --gcp)
            CREATE_DEV_GCP=true
            ;;
        --prod)
            CREATE_PROD_GCP=true
            ;;
        --all)
            CREATE_DEV_GCP=true
            CREATE_PROD_GCP=true
            CREATE_GITHUB=true
            ;;
    esac
done

# Create GCP secrets
if [ "$CREATE_DEV_GCP" = true ]; then
    create_gcp_secret "$DEV_PROJECT" "dev"
fi

if [ "$CREATE_PROD_GCP" = true ]; then
    create_gcp_secret "$PROD_PROJECT" "prod"
fi

# Create GitHub secret
if [ "$CREATE_GITHUB" = true ]; then
    echo ""
    echo "📦 Setting up GitHub Actions secret..."
    gh secret set INTERNAL_SERVICE_SECRET --body "$SECRET"
    echo "   ✅ GitHub secret configured"
fi

echo ""
echo "=============================================="
echo "📋 Configuration Summary"
echo "=============================================="
echo ""

if [ "$CREATE_DEV_GCP" = true ] || [ "$CREATE_PROD_GCP" = true ] || [ "$CREATE_GITHUB" = true ]; then
    echo "✅ Configured:"
    [ "$CREATE_DEV_GCP" = true ] && echo "   - GCP Secret Manager (dev: $DEV_PROJECT)"
    [ "$CREATE_PROD_GCP" = true ] && echo "   - GCP Secret Manager (prod: $PROD_PROJECT)"
    [ "$CREATE_GITHUB" = true ] && echo "   - GitHub Actions secrets"
    echo ""
fi

echo "📝 Manual steps required:"
echo ""
echo "1. For local development, update web/.env.local:"
echo "   INTERNAL_SERVICE_SECRET=\"dev-internal-secret\"  # Use simple value for local"
echo ""
echo "2. For Vercel production, add to Environment Variables:"
echo "   - Go to: Vercel Dashboard -> Settings -> Environment Variables"
echo "   - Add: INTERNAL_SERVICE_SECRET = $SECRET"
echo "   - Scope: Production (and optionally Preview)"
echo ""
echo "3. Quick commands (if not using --all):"
echo "   # GitHub secret:"
echo "   gh secret set INTERNAL_SERVICE_SECRET --body '$SECRET'"
echo ""
echo "   # GCP dev:"
echo "   echo -n '$SECRET' | gcloud secrets create INTERNAL_SERVICE_SECRET --data-file=- --project=$DEV_PROJECT"
echo ""
echo "   # GCP prod:"
echo "   echo -n '$SECRET' | gcloud secrets create INTERNAL_SERVICE_SECRET --data-file=- --project=$PROD_PROJECT"
echo ""
