#!/bin/bash

# Deploy script for Stock Price Ingestion Service
# This script deploys the service to Google Cloud Run and sets up Cloud Scheduler

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-dev-aba5688f"}
REGION=${GCP_REGION:-"australia-southeast2"}
SERVICE_NAME="stock-price-ingestion"
SERVICE_ACCOUNT="${SERVICE_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
# Ensure ALPHA_VANTAGE_API_KEY secret exists in Secret Manager
echo "🔐 Checking Alpha Vantage API key secret..."
if ! gcloud secrets describe ALPHA_VANTAGE_API_KEY --project=${PROJECT_ID} &> /dev/null; then
    echo "⚠️  ALPHA_VANTAGE_API_KEY secret not found in Secret Manager"
    echo ""
    if [ -n "$ALPHA_VANTAGE_API_KEY" ]; then
        echo "Creating secret from environment variable..."
        echo -n "$ALPHA_VANTAGE_API_KEY" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
            --data-file=- \
            --replication-policy="automatic" \
            --project=${PROJECT_ID}
        echo "✅ Secret created successfully"
    else
        echo "❌ Please set ALPHA_VANTAGE_API_KEY environment variable or create the secret manually:"
        echo ""
        echo "  # Option 1: From environment variable"
        echo "  export ALPHA_VANTAGE_API_KEY='your_key'"
        echo "  echo -n \"\$ALPHA_VANTAGE_API_KEY\" | gcloud secrets create ALPHA_VANTAGE_API_KEY \\"
        echo "    --data-file=- \\"
        echo "    --replication-policy=\"automatic\" \\"
        echo "    --project=${PROJECT_ID}"
        echo ""
        echo "  # Option 2: From file"
        echo "  echo -n 'your_key' > /tmp/alpha_vantage_key.txt"
        echo "  gcloud secrets create ALPHA_VANTAGE_API_KEY \\"
        echo "    --data-file=/tmp/alpha_vantage_key.txt \\"
        echo "    --replication-policy=\"automatic\" \\"
        echo "    --project=${PROJECT_ID}"
        echo "  rm /tmp/alpha_vantage_key.txt"
        echo ""
        exit 1
    fi
else
    echo "✅ ALPHA_VANTAGE_API_KEY secret exists in Secret Manager"
fi

echo ""
echo "🚀 Deploying Stock Price Ingestion Service"
echo "   Project: ${PROJECT_ID}"
echo "   Region: ${REGION}"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI is not installed. Please install it first."
    exit 1
fi

# Set the project
gcloud config set project ${PROJECT_ID}

# Enable required APIs
echo "📡 Enabling required APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    artifactregistry.googleapis.com

# Create service account if it doesn't exist
echo "👤 Setting up service account..."
if ! gcloud iam service-accounts describe ${SERVICE_ACCOUNT} &> /dev/null; then
    gcloud iam service-accounts create ${SERVICE_NAME} \
        --display-name="Stock Price Ingestion Service"
fi

# Grant necessary permissions
echo "🔐 Configuring IAM permissions..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/cloudsql.client" \
    --quiet

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet

# Grant specific access to the Alpha Vantage API key secret
echo "🔑 Granting access to ALPHA_VANTAGE_API_KEY secret..."
gcloud secrets add-iam-policy-binding ALPHA_VANTAGE_API_KEY \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} \
    --quiet

# Configure Docker authentication
echo "🔐 Configuring Docker authentication..."
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# Build Docker image locally
echo "🔨 Building Docker image..."
IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/shorted/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"
IMAGE_LATEST="${REGION}-docker.pkg.dev/${PROJECT_ID}/shorted/${SERVICE_NAME}:latest"

docker build -t ${IMAGE_TAG} -t ${IMAGE_LATEST} .

# Push to Artifact Registry
echo "📤 Pushing image to Artifact Registry..."
docker push ${IMAGE_TAG}
docker push ${IMAGE_LATEST}

# Deploy to Cloud Run using the service template
echo "🚀 Deploying to Cloud Run..."
# Update the service.yaml with the new image
sed "s|image: .*|image: ${IMAGE_TAG}|g" service.template.yaml > service.yaml

# Deploy the service
gcloud run services replace service.yaml \
    --region=${REGION} \
    --project=${PROJECT_ID}

# Wait for deployment to complete
echo "⏳ Waiting for deployment to complete..."
sleep 10

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} \
    --format='value(status.url)')

echo "✅ Service deployed at: ${SERVICE_URL}"

# Set up Cloud Scheduler for daily sync
echo "⏰ Setting up Cloud Scheduler..."

# Create scheduler job for daily market data sync (6 PM AEST / 8 AM UTC)
gcloud scheduler jobs create http stock-price-daily-sync \
    --location=${REGION} \
    --schedule="0 8 * * 1-5" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}/sync-all" \
    --http-method=POST \
    --headers="Content-Type=application/json" \
    --message-body='{}' \
    --max-retry-attempts=3 \
    --max-backoff=1h \
    --description="Daily sync of ASX stock prices from Yahoo Finance" \
    || echo "Scheduler job already exists, updating..."

# Update if it already exists
gcloud scheduler jobs update http stock-price-daily-sync \
    --location=${REGION} \
    --schedule="0 8 * * 1-5" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}/sync-all" \
    --http-method=POST \
    --headers="Content-Type=application/json" \
    --message-body='{}' \
    --max-retry-attempts=3 \
    --max-backoff=1h

# Create scheduler job for weekly comprehensive sync (Sunday night)
gcloud scheduler jobs create http stock-price-weekly-sync \
    --location=${REGION} \
    --schedule="0 10 * * 0" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}/sync" \
    --http-method=POST \
    --headers="Content-Type=application/json" \
    --message-body='{"days_back": 7, "mode": "backfill"}' \
    --max-retry-attempts=2 \
    --max-backoff=2h \
    --description="Weekly comprehensive sync of stock prices" \
    || echo "Weekly scheduler job already exists, updating..."

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Service Information:"
echo "   URL: ${SERVICE_URL}"
echo "   Health: ${SERVICE_URL}/health"
echo "   Docs: ${SERVICE_URL}/docs"
echo ""
echo "⏰ Scheduled Jobs:"
echo "   Daily: Weekdays at 6 PM AEST (after market close)"
echo "   Weekly: Sunday at 8 PM AEST (comprehensive sync)"
echo ""
echo "🔍 View logs:"
echo "   gcloud logging read \"resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_NAME}\" --limit 50"
echo ""
echo "🧪 Test manual sync:"
echo "   curl -X POST ${SERVICE_URL}/sync-all"