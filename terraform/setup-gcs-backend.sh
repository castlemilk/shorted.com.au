#!/bin/bash
set -e

# Setup GCS backend for Terraform state
# Usage: ./setup-gcs-backend.sh <environment>
# Example: ./setup-gcs-backend.sh dev

ENVIRONMENT=${1:-dev}

case $ENVIRONMENT in
  dev)
    PROJECT_ID="shorted-dev-aba5688f"
    REGION="australia-southeast2"
    ;;
  prod)
    PROJECT_ID="rosy-clover-477102-t5"
    REGION="australia-southeast2"
    ;;
  *)
    echo "❌ Unknown environment: $ENVIRONMENT"
    echo "Usage: $0 <dev|prod>"
    exit 1
    ;;
esac

BUCKET_NAME="${PROJECT_ID}-terraform-state"

echo "🔧 Setting up GCS backend for $ENVIRONMENT"
echo "   Project: $PROJECT_ID"
echo "   Bucket: $BUCKET_NAME"
echo ""

# Create bucket if it doesn't exist
if gsutil ls -b gs://${BUCKET_NAME} &>/dev/null; then
  echo "✅ Bucket already exists: gs://${BUCKET_NAME}"
else
  echo "📦 Creating bucket: gs://${BUCKET_NAME}"
  gcloud storage buckets create gs://${BUCKET_NAME} \
    --project=${PROJECT_ID} \
    --location=${REGION} \
    --uniform-bucket-level-access
  echo "✅ Bucket created"
fi

# Enable versioning
echo "📝 Enabling versioning..."
gcloud storage buckets update gs://${BUCKET_NAME} --versioning
echo "✅ Versioning enabled"

# Set lifecycle policy to delete old versions after 30 days
echo "🗑️  Setting lifecycle policy..."
cat > /tmp/lifecycle.json <<EOF
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {
          "numNewerVersions": 3,
          "daysSinceNoncurrentTime": 30
        }
      }
    ]
  }
}
EOF

gsutil lifecycle set /tmp/lifecycle.json gs://${BUCKET_NAME}
rm /tmp/lifecycle.json
echo "✅ Lifecycle policy set"

echo ""
echo "✅ GCS backend setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Run: cd environments/${ENVIRONMENT}"
echo "   2. Run: terraform init -migrate-state"
echo "   3. Verify state was migrated to gs://${BUCKET_NAME}"
echo ""

