#!/bin/bash

# Test script for preview deployment configuration
# This script checks that all environment variables are properly configured

echo "Testing Preview Deployment Configuration"
echo "========================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check file for hardcoded URLs
check_file_for_localhost() {
    local file=$1
    if grep -q "localhost:[89]09[01]" "$file" 2>/dev/null; then
        echo -e "${RED}✗${NC} $file contains hardcoded localhost URLs"
        return 1
    else
        echo -e "${GREEN}✓${NC} $file uses environment variables"
        return 0
    fi
}

# Function to check if file imports config
check_file_imports_config() {
    local file=$1
    if grep -q "from.*config" "$file" 2>/dev/null || grep -q "from '~/app/actions/config'" "$file" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $file imports centralized config"
        return 0
    else
        # Check if it's a file that doesn't need config (like search API)
        if ! grep -q "MARKET_DATA_API_URL\|SHORTS_API_URL" "$file" 2>/dev/null; then
            echo -e "${YELLOW}○${NC} $file doesn't need API config"
            return 0
        else
            echo -e "${RED}✗${NC} $file should import centralized config"
            return 1
        fi
    fi
}

echo ""
echo "1. Checking Server Actions..."
echo "------------------------------"
cd /Users/benebsworth/projects/shorted/web/src/app/actions

for file in *.ts; do
    if [[ "$file" == "config.ts" ]]; then
        continue
    fi
    check_file_for_localhost "$file"
    if [[ "$file" != "auth.ts" && "$file" != "portfolio.ts" && "$file" != "dashboard.ts" ]]; then
        check_file_imports_config "$file"
    fi
done

echo ""
echo "2. Checking API Routes..."
echo "-------------------------"
cd /Users/benebsworth/projects/shorted/web/src/app/api

# Find all route.ts files
find . -name "route.ts" -type f | while read -r file; do
    check_file_for_localhost "$file"
    # Only check for config import if the file uses API URLs
    if grep -q "MARKET_DATA_API_URL\|fetch.*http" "$file" 2>/dev/null; then
        check_file_imports_config "$file"
    fi
done

echo ""
echo "3. Checking GitHub Actions Workflows..."
echo "---------------------------------------"
cd /Users/benebsworth/projects/shorted/.github/workflows

# Check for preview deployment workflow
if [[ -f "preview-deploy.yml" ]]; then
    echo -e "${GREEN}✓${NC} preview-deploy.yml exists"
    
    # Check for required environment variables
    if grep -q "NEXT_PUBLIC_API_URL" preview-deploy.yml && \
       grep -q "NEXT_PUBLIC_MARKET_DATA_URL" preview-deploy.yml; then
        echo -e "${GREEN}✓${NC} Environment variables are passed to Vercel"
    else
        echo -e "${RED}✗${NC} Missing environment variable configuration"
    fi
    
    # Check for Workload Identity
    if grep -q "google-github-actions/auth" preview-deploy.yml; then
        echo -e "${GREEN}✓${NC} Uses Workload Identity Federation"
    else
        echo -e "${RED}✗${NC} Not using Workload Identity Federation"
    fi
else
    echo -e "${RED}✗${NC} preview-deploy.yml not found"
fi

# Check for cleanup workflow
if [[ -f "preview-cleanup.yml" ]]; then
    echo -e "${GREEN}✓${NC} preview-cleanup.yml exists"
else
    echo -e "${RED}✗${NC} preview-cleanup.yml not found"
fi

echo ""
echo "4. Checking Terraform Configuration..."
echo "--------------------------------------"
cd /Users/benebsworth/projects/shorted

if [[ -d "terraform" ]]; then
    echo -e "${GREEN}✓${NC} terraform directory exists"
    
    if [[ -f "terraform/workload-identity.tf" ]]; then
        echo -e "${GREEN}✓${NC} workload-identity.tf exists"
    else
        echo -e "${RED}✗${NC} workload-identity.tf not found"
    fi
else
    echo -e "${YELLOW}○${NC} terraform directory not found (may be intentional)"
fi

echo ""
echo "5. Checking Environment Configuration..."
echo "----------------------------------------"
cd /Users/benebsworth/projects/shorted/web

# Check for centralized config file
if [[ -f "src/app/actions/config.ts" ]]; then
    echo -e "${GREEN}✓${NC} Centralized config file exists"
    
    # Check config exports the right functions
    if grep -q "getShortsApiUrl\|getMarketDataApiUrl" src/app/actions/config.ts; then
        echo -e "${GREEN}✓${NC} Config exports required functions"
    else
        echo -e "${RED}✗${NC} Config missing required exports"
    fi
else
    echo -e "${RED}✗${NC} Centralized config file not found"
fi

echo ""
echo "========================================"
echo "Preview Deployment Configuration Test Complete"
echo ""
echo "To test an actual preview deployment:"
echo "1. Create a test branch: git checkout -b test/preview-deployment"
echo "2. Make a small change and commit"
echo "3. Push and create a PR: git push -u origin test/preview-deployment"
echo "4. Check GitHub Actions for the preview deployment workflow"
echo "5. Verify Vercel preview URL connects to preview backend"
echo "6. Close PR to test cleanup"