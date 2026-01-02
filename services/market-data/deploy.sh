#!/bin/bash

# Deploy script for Market Data Sync Service
# This script deploys the service to Google Cloud Run and sets up Cloud Scheduler

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-dev-aba5688f"}
REGION="australia-southeast1"
SERVICE_NAME="market-data-sync"
SERVICE_ACCOUNT="market-data-sync@${PROJECT_ID}.iam.gserviceaccount.com"

echo "🚀 Deploying Enhanced ASX Market Data Service"
echo "   Project: ${PROJECT_ID}"
echo "   Region: ${REGION}"
echo "   Features: Dynamic ASX stocks, Alpha Vantage + Yahoo Finance fallback"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI is not installed. Please install it first."
    exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL environment variable is required"
    echo "   Usage: export DATABASE_URL='your-database-url'"
    exit 1
fi

# Check if ALPHA_VANTAGE_API_KEY is set
if [ -z "$ALPHA_VANTAGE_API_KEY" ]; then
    echo "⚠️  ALPHA_VANTAGE_API_KEY not set, using default key"
    ALPHA_VANTAGE_API_KEY="UOI9AM59F03A0WZC"
fi

# Set the project
gcloud config set project ${PROJECT_ID}

# Enable required APIs
echo "📡 Enabling required APIs..."
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    containerregistry.googleapis.com

# Create service account if it doesn't exist
echo "👤 Setting up service account..."
if ! gcloud iam service-accounts describe ${SERVICE_ACCOUNT} &> /dev/null; then
    gcloud iam service-accounts create ${SERVICE_NAME} \
        --display-name="Market Data Sync Service"
fi

# Grant necessary permissions
echo "🔐 Configuring IAM permissions..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor"

# Build and deploy directly to Cloud Run
echo "🔨 Building and deploying service..."

# Build the Docker image
echo "Building Docker image..."
docker build --platform linux/amd64 -t market-data-sync:latest .

# Tag for GCR
echo "Authenticating with GCR..."
gcloud auth configure-docker --quiet
docker tag market-data-sync:latest gcr.io/${PROJECT_ID}/market-data-sync:latest

# Push to GCR
echo "Pushing to Container Registry..."
docker push gcr.io/${PROJECT_ID}/market-data-sync:latest

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy market-data-sync \
    --image gcr.io/${PROJECT_ID}/market-data-sync:latest \
    --region australia-southeast1 \
    --platform managed \
    --allow-unauthenticated \
    --set-env-vars DATABASE_URL="${DATABASE_URL}" \
    --set-env-vars ALPHA_VANTAGE_API_KEY="${ALPHA_VANTAGE_API_KEY}" \
    --max-instances 1 \
    --timeout 900 \
    --memory 1Gi \
    --cpu 1 \
    --port 8090 \
    --service-account market-data-sync@${PROJECT_ID}.iam.gserviceaccount.com

# Get the service URL
SERVICE_URL=$(gcloud run services describe market-data-sync \
    --region=australia-southeast1 \
    --format='value(status.url)')

echo "✅ Service deployed at: ${SERVICE_URL}"

# Set up Cloud Scheduler for daily sync
echo "⏰ Setting up Cloud Scheduler..."

# Create scheduler job for daily market data sync (6 PM AEST / 8 AM UTC)
gcloud scheduler jobs create http market-data-daily-sync \
    --location=australia-southeast1 \
    --schedule="0 8 * * 1-5" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}/sync" \
    --http-method=POST \
    --message-body='{}' \
    --max-retry-attempts=3 \
    --max-backoff=1h \
    --description="Daily sync of ASX stock prices with Alpha Vantage priority and Yahoo Finance fallback" \
    || echo "Scheduler job already exists, updating..."

# Update if it already exists
gcloud scheduler jobs update http market-data-daily-sync \
    --location=australia-southeast1 \
    --schedule="0 8 * * 1-5" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}/sync" \
    --http-method=POST \
    --message-body='{}' \
    --max-retry-attempts=3 \
    --max-backoff=1h

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
echo ""
echo "🔍 View logs:"
echo "   gcloud logging read \"resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_NAME}\" --limit 50"
echo ""
echo "🧪 Test manual sync:"
echo "   curl -X POST ${SERVICE_URL}/sync"
