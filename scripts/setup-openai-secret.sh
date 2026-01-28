#!/bin/bash
# Setup OPENAI_API_KEY secret in GCP Secret Manager
#
# Usage:
#   ./scripts/setup-openai-secret.sh              # Create in dev project
#   ./scripts/setup-openai-secret.sh --prod       # Create in prod project
#   OPENAI_API_KEY=sk-xxx ./scripts/setup-openai-secret.sh  # Pass key via env var

set -euo pipefail

DEV_PROJECT="shorted-dev-aba5688f"
PROD_PROJECT="shorted-prod-a0205b20"
SECRET_NAME="OPENAI_API_KEY"

# Determine project
if [[ "${1:-}" == "--prod" ]]; then
    PROJECT_ID="$PROD_PROJECT"
    echo "🔐 Setting up $SECRET_NAME in PROD project: $PROJECT_ID"
else
    PROJECT_ID="$DEV_PROJECT"
    echo "🔐 Setting up $SECRET_NAME in DEV project: $PROJECT_ID"
fi

# Get API key from environment or prompt
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    # Try to read from analysis/.env
    if [[ -f "analysis/.env" ]]; then
        OPENAI_API_KEY=$(grep -E "^OPENAI_API_KEY=" analysis/.env | cut -d '=' -f2- | tr -d '"' | tr -d "'" || true)
    fi
    
    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
        echo "Enter your OpenAI API key:"
        read -s OPENAI_API_KEY
        echo ""
    else
        echo "✅ Found OPENAI_API_KEY in analysis/.env"
    fi
fi

if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "❌ Error: OPENAI_API_KEY is required"
    exit 1
fi

# Validate the key format
if [[ ! "$OPENAI_API_KEY" =~ ^sk- ]]; then
    echo "⚠️  Warning: API key doesn't start with 'sk-' - are you sure this is correct?"
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if secret exists
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" &>/dev/null; then
    echo "📝 Secret exists, adding new version..."
    echo -n "$OPENAI_API_KEY" | gcloud secrets versions add "$SECRET_NAME" \
        --data-file=- \
        --project="$PROJECT_ID"
    echo "✅ New version added to $SECRET_NAME"
else
    echo "🆕 Creating new secret..."
    echo -n "$OPENAI_API_KEY" | gcloud secrets create "$SECRET_NAME" \
        --data-file=- \
        --replication-policy="automatic" \
        --project="$PROJECT_ID"
    echo "✅ Secret $SECRET_NAME created"
fi

echo ""
echo "🎉 Done! The secret is now available in GCP Secret Manager."
echo ""
echo "To verify:"
echo "  gcloud secrets versions list $SECRET_NAME --project=$PROJECT_ID"
echo ""
echo "Services that use this secret:"
echo "  - enrichment-processor"
echo "  - shorts-api"
