#!/bin/bash

# Simple script to build and push Docker image without Cloud Build
# Useful for local development and testing

set -e

# Configuration
PROJECT_ID=${GCP_PROJECT:?Set GCP_PROJECT explicitly}
REGION=${REGION:-"australia-southeast2"}
SERVICE_NAME="stock-price-ingestion"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Image names
IMAGE_TAG="australia-southeast2-docker.pkg.dev/${PROJECT_ID}/shorted/${SERVICE_NAME}:${TIMESTAMP}"
IMAGE_LATEST="australia-southeast2-docker.pkg.dev/${PROJECT_ID}/shorted/${SERVICE_NAME}:latest"

echo "🐳 Building and pushing Docker image"
echo "   Project: ${PROJECT_ID}"
echo "   Region: ${REGION}"
echo "   Tag: ${TIMESTAMP}"
echo ""

# Configure Docker to use gcloud as a credential helper
echo "🔐 Configuring Docker authentication..."
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# Build the image
echo "🔨 Building Docker image..."
docker build -t ${IMAGE_TAG} -t ${IMAGE_LATEST} .

# Push to Artifact Registry
echo "📤 Pushing to Artifact Registry..."
docker push ${IMAGE_TAG}
docker push ${IMAGE_LATEST}

echo ""
echo "✅ Image built and pushed successfully!"
echo ""
echo "📝 Image details:"
echo "   Tagged: ${IMAGE_TAG}"
echo "   Latest: ${IMAGE_LATEST}"
echo ""
echo "🚀 To deploy this image:"
echo "   ./deploy.sh"
echo ""
echo "   Or manually:"
echo "   gcloud run deploy ${SERVICE_NAME} \\"
echo "     --image ${IMAGE_TAG} \\"
echo "     --region ${REGION} \\"
echo "     --project ${PROJECT_ID}"
