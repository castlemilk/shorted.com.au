#!/bin/bash

# Setup script for creating secrets in GCP Secret Manager
# Run this script once to set up the required secrets for the stock-price-ingestion service

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-dev-aba5688f"}
SERVICE_ACCOUNT="stock-price-ingestion@${PROJECT_ID}.iam.gserviceaccount.com"

echo "🔐 Setting up secrets for Stock Price Ingestion Service"
echo "   Project: ${PROJECT_ID}"
echo ""

# Set the project
gcloud config set project ${PROJECT_ID}

# Create ALPHA_VANTAGE_API_KEY secret
echo "📝 Setting up ALPHA_VANTAGE_API_KEY secret..."
echo ""

if gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=${PROJECT_ID} &> /dev/null; then
    echo "✅ ALPHA_VANTAGE_API_KEY secret already exists"
    echo ""
    read -p "Do you want to update it? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "Enter your Alpha Vantage API key: " -s API_KEY
        echo
        echo -n "$API_KEY" | gcloud secrets versions add ALPHA_VANTAGE_API_KEY \
            --data-file=- \
            --project=${PROJECT_ID}
        echo "✅ Secret updated successfully"
    fi
else
    echo "Creating new ALPHA_VANTAGE_API_KEY secret..."
    echo "Get your free key from: https://www.alphavantage.co/support/#api-key"
    echo ""
    read -p "Enter your Alpha Vantage API key: " -s API_KEY
    echo
    
    if [ -z "$API_KEY" ]; then
        echo "❌ API key cannot be empty"
        exit 1
    fi
    
    echo -n "$API_KEY" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
        --data-file=- \
        --replication-policy="automatic" \
        --project=${PROJECT_ID}
    
    echo "✅ Secret created successfully"
fi

echo ""
echo "🔑 Granting service account access to secrets..."

# Grant access to the service account
gcloud secrets add-iam-policy-binding ALPHA_VANTAGE_API_KEY \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} \
    --quiet

gcloud secrets add-iam-policy-binding DATABASE_URL \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} \
    --quiet 2>/dev/null || echo "⚠️  DATABASE_URL secret not found (may need to be created separately)"

echo ""
echo "✅ Secrets setup complete!"
echo ""
echo "📋 Verify secrets:"
echo "  gcloud secrets list --project=${PROJECT_ID}"
echo ""
echo "🔍 View secret metadata:"
echo "  gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=${PROJECT_ID}"
echo ""
echo "🚀 You can now deploy the service:"
echo "  ./deploy.sh"

