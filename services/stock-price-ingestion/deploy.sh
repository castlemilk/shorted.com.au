#!/bin/bash

# Deploy script for Stock Price Ingestion Service
# This script deploys the service to Google Cloud Run and sets up Cloud Scheduler

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-prod"}
REGION=${GCP_REGION:-"australia-southeast1"}
SERVICE_NAME="stock-price-ingestion"
SERVICE_ACCOUNT="${SERVICE_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

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
    cloudbuild.googleapis.com \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    containerregistry.googleapis.com

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
    --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor"

# Build and deploy using Cloud Build
echo "🔨 Building and deploying service..."
gcloud builds submit \
    --config=cloudbuild.yaml \
    --substitutions=_DATABASE_URL="${DATABASE_URL}",_ENVIRONMENT="production" \
    .

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} \
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