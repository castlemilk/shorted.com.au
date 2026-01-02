#!/bin/bash
# Deploy daily historical data sync as a Cloud Run job

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:-"shorted-dev-aba5688f"}
REGION=${GCP_REGION:-"asia-northeast1"}
JOB_NAME="daily-historical-sync"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${JOB_NAME}"

echo "🚀 Deploying Daily Historical Sync Job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Job: $JOB_NAME"
echo ""

# Check required environment variables
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL environment variable is required"
    exit 1
fi

echo "📦 Building Docker image..."
docker build \
    --platform linux/amd64 \
    -t ${IMAGE_NAME}:latest \
    -f Dockerfile.daily-sync \
    .

echo ""
echo "📤 Pushing image to Google Container Registry..."
docker push ${IMAGE_NAME}:latest

echo ""
echo "☁️  Creating/Updating Cloud Run Job..."
gcloud run jobs deploy ${JOB_NAME} \
    --image ${IMAGE_NAME}:latest \
    --region ${REGION} \
    --project ${PROJECT_ID} \
    --set-env-vars DATABASE_URL="${DATABASE_URL}" \
    --set-env-vars SYNC_DAYS="5" \
    --memory 2Gi \
    --cpu 1 \
    --max-retries 2 \
    --task-timeout 3600 \
    --execute-now=false

echo ""
echo "⏰ Setting up Cloud Scheduler (daily at 2 AM AEST)..."
SCHEDULE_EXISTS=$(gcloud scheduler jobs list --location=${REGION} --project=${PROJECT_ID} --filter="name:${JOB_NAME}" --format="value(name)" || echo "")

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
        --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
        --http-method POST \
        --oauth-service-account-email ${PROJECT_ID}@appspot.gserviceaccount.com \
        --project ${PROJECT_ID}
fi

echo ""
echo "✅ Deployment complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Job Details:"
echo "  Name: ${JOB_NAME}"
echo "  Schedule: Daily at 2 AM AEST"
echo "  Sync Period: Last 5 days"
echo ""
echo "🎯 Manual execution:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --project ${PROJECT_ID}"
echo ""
echo "📊 View logs:"
echo "  gcloud logging read \"resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}\" --limit 50 --project ${PROJECT_ID}"
echo ""

