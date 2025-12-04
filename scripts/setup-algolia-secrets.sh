#!/bin/bash
# Setup Algolia secrets in GCP Secret Manager
# Run this script to configure Algolia for both dev and prod environments

set -e

# Algolia credentials
ALGOLIA_APP_ID="1BWAPWSTDD"
ALGOLIA_SEARCH_KEY="0e5adba5fd8aa4b3848255a39c1287ef"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔐 Setting up Algolia secrets in GCP Secret Manager${NC}"
echo ""

# Function to create or update a secret
create_secret() {
    local project=$1
    local secret_name=$2
    local secret_value=$3
    
    echo -e "  Creating/updating ${secret_name} in ${project}..."
    
    # Check if secret exists
    if gcloud secrets describe "$secret_name" --project="$project" &>/dev/null; then
        # Update existing secret
        echo "$secret_value" | gcloud secrets versions add "$secret_name" \
            --project="$project" \
            --data-file=-
        echo -e "    ${GREEN}✓ Updated${NC}"
    else
        # Create new secret
        echo "$secret_value" | gcloud secrets create "$secret_name" \
            --project="$project" \
            --replication-policy="automatic" \
            --data-file=-
        echo -e "    ${GREEN}✓ Created${NC}"
    fi
}

# Dev environment
DEV_PROJECT="shorted-dev-aba5688f"
echo -e "${YELLOW}📦 Dev Environment (${DEV_PROJECT})${NC}"
create_secret "$DEV_PROJECT" "ALGOLIA_APP_ID" "$ALGOLIA_APP_ID"
create_secret "$DEV_PROJECT" "ALGOLIA_SEARCH_KEY" "$ALGOLIA_SEARCH_KEY"

# Grant access to shorts service account
echo -e "  Granting access to shorts service account..."
for secret in ALGOLIA_APP_ID ALGOLIA_SEARCH_KEY; do
    gcloud secrets add-iam-policy-binding "$secret" \
        --project="$DEV_PROJECT" \
        --member="serviceAccount:shorts@${DEV_PROJECT}.iam.gserviceaccount.com" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet 2>/dev/null || true
done
echo -e "    ${GREEN}✓ Access granted${NC}"

# Prod environment
PROD_PROJECT="rosy-clover-477102-t5"
echo ""
echo -e "${YELLOW}📦 Prod Environment (${PROD_PROJECT})${NC}"
create_secret "$PROD_PROJECT" "ALGOLIA_APP_ID" "$ALGOLIA_APP_ID"
create_secret "$PROD_PROJECT" "ALGOLIA_SEARCH_KEY" "$ALGOLIA_SEARCH_KEY"

# Grant access to shorts service account in prod
echo -e "  Granting access to shorts service account..."
for secret in ALGOLIA_APP_ID ALGOLIA_SEARCH_KEY; do
    gcloud secrets add-iam-policy-binding "$secret" \
        --project="$PROD_PROJECT" \
        --member="serviceAccount:shorts@${PROD_PROJECT}.iam.gserviceaccount.com" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet 2>/dev/null || true
done
echo -e "    ${GREEN}✓ Access granted${NC}"

echo ""
echo -e "${GREEN}✅ Algolia secrets configured successfully!${NC}"
echo ""
echo "Next steps:"
echo "  1. Add these GitHub secrets for Vercel deployments:"
echo "     - ALGOLIA_APP_ID: $ALGOLIA_APP_ID"
echo "     - ALGOLIA_SEARCH_KEY: $ALGOLIA_SEARCH_KEY"
echo ""
echo "  2. Redeploy the shorts service to pick up the new secrets:"
echo "     - For preview: Open a new PR or re-run the CI workflow"
echo "     - For prod: Create a release or manually trigger terraform-deploy"

