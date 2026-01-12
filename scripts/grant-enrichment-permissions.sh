#!/bin/bash
# Grant Pub/Sub and Service Account permissions to GitHub Actions service account
# This is needed for the enrichment-processor module to create Pub/Sub topics and service accounts

set -e

PROJECT_ID="${1:-shorted-dev-aba5688f}"
SA_EMAIL="github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com"

echo "🔐 Granting permissions to GitHub Actions service account..."
echo "   Project: ${PROJECT_ID}"
echo "   Service Account: ${SA_EMAIL}"
echo ""

# Grant Pub/Sub Admin role (needed to create topics and subscriptions)
echo "📡 Granting Pub/Sub Admin role..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/pubsub.admin" \
    --condition=None \
    --quiet || echo "⚠️  Failed to grant Pub/Sub Admin (may already be granted)"

# Grant Service Account Admin role (needed to create service accounts)
echo "👤 Granting Service Account Admin role..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/iam.serviceAccountAdmin" \
    --condition=None \
    --quiet || echo "⚠️  Failed to grant Service Account Admin (may already be granted)"

echo ""
echo "✅ Permissions granted!"
echo ""
echo "📝 For production, run:"
echo "   ./scripts/grant-enrichment-permissions.sh rosy-clover-477102-t5"
