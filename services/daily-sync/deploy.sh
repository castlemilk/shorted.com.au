#!/bin/bash
# Deploy Comprehensive Daily Sync as a Cloud Run Job

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-dev-aba5688f"}
REGION=${GCP_REGION:-"asia-northeast1"}
JOB_NAME="comprehensive-daily-sync"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${JOB_NAME}"

echo "🚀 Deploying Comprehensive Daily Sync Job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Job: $JOB_NAME"
echo ""

# Check required environment variables
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL environment variable is required"
    echo "   Usage: export DATABASE_URL='postgresql://...'"
    exit 1
fi

# Alpha Vantage is optional but recommended
if [ -z "$ALPHA_VANTAGE_API_KEY" ]; then
    echo "⚠️  WARNING: ALPHA_VANTAGE_API_KEY not set"
    echo "   Will use Yahoo Finance only (less reliable)"
    echo "   Set it with: export ALPHA_VANTAGE_API_KEY='your-api-key'"
    echo ""
    read -p "Continue without Alpha Vantage? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for optional Alpha Vantage API key
if [ -z "$ALPHA_VANTAGE_API_KEY" ]; then
    echo "⚠️  ALPHA_VANTAGE_API_KEY not set - will use Yahoo Finance only"
    echo "   For better reliability, get a free API key from: https://www.alphavantage.co/support/#api-key"
else
    echo "✅ Alpha Vantage API key detected - will use as primary source"
fi

echo "📦 Building Docker image..."
docker build \
    --platform linux/amd64 \
    -t ${IMAGE_NAME}:latest \
    .

echo ""
echo "🔐 Configuring Docker for GCR..."
gcloud auth configure-docker gcr.io --quiet

echo ""
echo "📤 Pushing image to Google Container Registry..."
docker push ${IMAGE_NAME}:latest

echo ""
echo "☁️  Creating/Updating Cloud Run Job..."

# Build env vars command
ENV_VARS="DATABASE_URL=${DATABASE_URL},SYNC_DAYS_STOCK_PRICES=5,SYNC_DAYS_SHORTS=7"
if [ -n "$ALPHA_VANTAGE_API_KEY" ]; then
    ENV_VARS="${ENV_VARS},ALPHA_VANTAGE_API_KEY=${ALPHA_VANTAGE_API_KEY}"
fi

gcloud run jobs deploy ${JOB_NAME} \
    --image ${IMAGE_NAME}:latest \
    --region ${REGION} \
    --project ${PROJECT_ID} \
    --set-env-vars "${ENV_VARS}" \
    --memory 2Gi \
    --cpu 1 \
    --max-retries 2 \
    --task-timeout 3600

echo ""
echo "⏰ Setting up Cloud Scheduler (daily at 2 AM AEST)..."

# Check if scheduler job exists
SCHEDULE_EXISTS=$(gcloud scheduler jobs list \
    --location=${REGION} \
    --project=${PROJECT_ID} \
    --filter="name:${JOB_NAME}-trigger" \
    --format="value(name)" 2>/dev/null || echo "")

if [ -z "$SCHEDULE_EXISTS" ]; then
    echo "Creating new schedule..."
    gcloud scheduler jobs create http ${JOB_NAME}-trigger \
        --location ${REGION} \
        --schedule "0 2 * * *" \
        --time-zone "Australia/Sydney" \
        --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
        --http-method POST \
        --oauth-service-account-email ${PROJECT_ID}@appspot.gserviceaccount.com \
        --project ${PROJECT_ID}
else
    echo "Updating existing schedule..."
    gcloud scheduler jobs update http ${JOB_NAME}-trigger \
        --location ${REGION} \
        --schedule "0 2 * * *" \
        --time-zone "Australia/Sydney" \
        --project ${PROJECT_ID}
fi

echo ""
echo "✅ Deployment complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Job Details:"
echo "  Name: ${JOB_NAME}"
echo "  Schedule: Daily at 2 AM AEST"
echo "  Updates:"
echo "    - Shorts data (last 7 days from ASIC)"
if [ -n "$ALPHA_VANTAGE_API_KEY" ]; then
    echo "    - Stock prices (last 5 days - Alpha Vantage + Yahoo Finance fallback)"
else
    echo "    - Stock prices (last 5 days - Yahoo Finance only)"
fi
echo ""
echo "🎯 Manual execution:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --project ${PROJECT_ID}"
echo ""
echo "📊 View logs:"
echo "  gcloud logging read \"resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}\" --limit 50 --project ${PROJECT_ID}"
echo ""
echo "⏰ View scheduler:"
echo "  gcloud scheduler jobs describe ${JOB_NAME}-trigger --location ${REGION} --project ${PROJECT_ID}"
echo ""

