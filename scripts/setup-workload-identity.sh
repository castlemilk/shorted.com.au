#!/bin/bash

# Setup Workload Identity Federation for GitHub Actions
# This script configures GCP to allow GitHub Actions to authenticate without service account keys

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-}"
GITHUB_ORG="${GITHUB_ORG:-benebsworth}"
GITHUB_REPO="${GITHUB_REPO:-shorted}"

echo -e "${GREEN}🔐 Setting up Workload Identity Federation for GitHub Actions${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}📋 Checking prerequisites...${NC}"

if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}❌ gcloud CLI is not installed${NC}"
    echo "Please install: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

if ! command -v terraform &> /dev/null; then
    echo -e "${YELLOW}⚠️  Terraform is not installed${NC}"
    echo "Installing terraform is recommended for infrastructure management"
    echo "Visit: https://www.terraform.io/downloads"
    echo ""
    echo "Alternatively, you can use the gcloud commands below"
fi

# Get or set project ID
if [ -z "$PROJECT_ID" ]; then
    echo -e "${YELLOW}Enter your GCP Project ID:${NC}"
    read -r PROJECT_ID
fi

echo -e "${GREEN}✅ Using project: $PROJECT_ID${NC}"
echo ""

# Option 1: Use Terraform (recommended)
if command -v terraform &> /dev/null; then
    echo -e "${YELLOW}🔧 Using Terraform to set up resources...${NC}"
    
    cd terraform
    
    # Initialize Terraform
    terraform init
    
    # Plan the changes
    terraform plan \
        -var="project_id=$PROJECT_ID" \
        -var="github_org=$GITHUB_ORG" \
        -var="github_repo=$GITHUB_REPO" \
        -out=workload-identity.tfplan
    
    echo ""
    echo -e "${YELLOW}Review the plan above. Continue? (y/n)${NC}"
    read -r CONTINUE
    
    if [ "$CONTINUE" != "y" ]; then
        echo "Aborted"
        exit 0
    fi
    
    # Apply the configuration
    terraform apply workload-identity.tfplan
    
    # Get outputs
    WIP_PROVIDER=$(terraform output -raw workload_identity_provider)
    SA_EMAIL=$(terraform output -raw service_account_email)
    
else
    # Option 2: Use gcloud commands directly
    echo -e "${YELLOW}🔧 Using gcloud to set up resources...${NC}"
    
    # Set the project
    gcloud config set project "$PROJECT_ID"
    
    # Enable required APIs
    echo "Enabling required APIs..."
    gcloud services enable iam.googleapis.com \
        cloudresourcemanager.googleapis.com \
        iamcredentials.googleapis.com \
        sts.googleapis.com \
        run.googleapis.com \
        artifactregistry.googleapis.com
    
    # Create Workload Identity Pool
    echo "Creating Workload Identity Pool..."
    gcloud iam workload-identity-pools create github-pool \
        --location="global" \
        --display-name="GitHub Actions Pool" \
        --description="Workload Identity Pool for GitHub Actions" \
        2>/dev/null || echo "Pool already exists"
    
    # Create Workload Identity Provider
    echo "Creating Workload Identity Provider..."
    gcloud iam workload-identity-pools providers create-oidc github-provider \
        --location="global" \
        --workload-identity-pool="github-pool" \
        --display-name="GitHub Provider" \
        --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
        --attribute-condition="assertion.repository_owner == '${GITHUB_ORG}'" \
        --issuer-uri="https://token.actions.githubusercontent.com" \
        2>/dev/null || echo "Provider already exists"
    
    # Create Service Account
    echo "Creating Service Account..."
    gcloud iam service-accounts create github-actions-sa \
        --display-name="GitHub Actions Service Account" \
        --description="Service account for GitHub Actions CI/CD" \
        2>/dev/null || echo "Service account already exists"
    
    SA_EMAIL="github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com"
    
    # Grant roles to Service Account
    echo "Granting roles to Service Account..."
    for role in \
        "roles/run.admin" \
        "roles/artifactregistry.writer" \
        "roles/storage.admin" \
        "roles/iam.serviceAccountUser"
    do
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:${SA_EMAIL}" \
            --role="$role" \
            --condition=None \
            2>/dev/null || true
    done
    
    # Allow impersonation from GitHub
    echo "Setting up impersonation..."
    gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
        --role="roles/iam.workloadIdentityUser" \
        --member="principalSet://iam.googleapis.com/projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}"
    
    # Create Artifact Registry repository
    echo "Creating Artifact Registry repository..."
    gcloud artifacts repositories create shorted \
        --repository-format=docker \
        --location=australia-southeast2 \
        --description="Docker repository for Shorted services" \
        2>/dev/null || echo "Repository already exists"
    
    WIP_PROVIDER="projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
fi

echo ""
echo -e "${GREEN}✅ Workload Identity Federation setup complete!${NC}"
echo ""
echo -e "${YELLOW}📝 Add these secrets to your GitHub repository:${NC}"
echo ""
echo "1. Go to: https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/settings/secrets/actions"
echo ""
echo "2. Add the following secrets:"
echo "   GCP_PROJECT_ID: ${PROJECT_ID}"
echo "   WIP_PROVIDER: ${WIP_PROVIDER}"
echo "   SA_EMAIL: ${SA_EMAIL}"
echo ""
echo "3. The GitHub Actions workflow is already configured to use these secrets"
echo ""
echo -e "${GREEN}🎉 Setup complete! Your GitHub Actions can now authenticate to GCP without keys.${NC}"