#!/bin/bash

# Script to set up GitHub secrets for preview deployments
# Run this after setting up Workload Identity Federation with Terraform

echo "GitHub Secrets Setup for Preview Deployments"
echo "============================================"
echo ""
echo "This script will help you set up the required GitHub secrets for preview deployments."
echo "Make sure you've already run the Terraform setup for Workload Identity Federation."
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is not installed. Please install it first:"
    echo "   brew install gh"
    exit 1
fi

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not in a git repository"
    exit 1
fi

# Get repository info
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "Repository: $REPO"
echo ""

# Get GCP project ID
read -p "Enter your GCP Project ID: " GCP_PROJECT_ID
if [ -z "$GCP_PROJECT_ID" ]; then
    echo "❌ GCP Project ID is required"
    exit 1
fi

# Calculate values based on project ID
WIP_PROVIDER="projects/${GCP_PROJECT_ID}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
SA_EMAIL="github-actions@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "Calculated values:"
echo "  Workload Identity Provider: $WIP_PROVIDER"
echo "  Service Account Email: $SA_EMAIL"
echo ""

# Confirm before proceeding
read -p "Do you want to set these secrets in GitHub? (y/N): " -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
fi

# Set secrets
echo "Setting GitHub secrets..."

# Set GCP_PROJECT_ID
gh secret set GCP_PROJECT_ID --body="$GCP_PROJECT_ID"
echo "✅ Set GCP_PROJECT_ID"

# Set WIP_PROVIDER
gh secret set WIP_PROVIDER --body="$WIP_PROVIDER"
echo "✅ Set WIP_PROVIDER"

# Set SA_EMAIL
gh secret set SA_EMAIL --body="$SA_EMAIL"
echo "✅ Set SA_EMAIL"

# Also set Supabase URL and key if available
read -p "Enter your Supabase URL (or press Enter to skip): " SUPABASE_URL
if [ ! -z "$SUPABASE_URL" ]; then
    gh secret set SUPABASE_URL --body="$SUPABASE_URL"
    echo "✅ Set SUPABASE_URL"
fi

read -p "Enter your Supabase Anon Key (or press Enter to skip): " SUPABASE_ANON_KEY
if [ ! -z "$SUPABASE_ANON_KEY" ]; then
    gh secret set SUPABASE_ANON_KEY --body="$SUPABASE_ANON_KEY"
    echo "✅ Set SUPABASE_ANON_KEY"
fi

echo ""
echo "GitHub secrets have been configured successfully!"
echo ""
echo "Next steps:"
echo "1. Make sure Workload Identity Federation is set up in GCP"
echo "2. Push a commit to trigger the preview deployment"
echo "3. Check the GitHub Actions tab for the deployment status"
echo ""
echo "To verify the secrets are set:"
echo "  gh secret list"