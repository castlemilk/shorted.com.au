#!/bin/bash

# Script to check the deployment status of the stock price ingestion service
# and provide logging/monitoring commands

set -e

PROJECT_ID="shorted-dev"
REGION="australia-southeast1"
SERVICE_NAME="stock-price-ingestion"

echo "================================================"
echo "Stock Price Ingestion - Deployment Status Check"
echo "================================================"
echo ""

echo "Checking Cloud Run Services..."
echo "-------------------------------"
gcloud run services list --project=$PROJECT_ID --region=$REGION 2>&1 | grep -E "(SERVICE|stock)" || echo "⚠️  No stock-related services found or permission denied"
echo ""

echo "Checking Cloud Run Jobs..."
echo "-------------------------"
gcloud run jobs list --project=$PROJECT_ID --region=$REGION 2>&1 | grep -E "(JOB|stock)" || echo "⚠️  No stock-related jobs found or permission denied"
echo ""

echo "Checking Cloud Scheduler Jobs..."
echo "--------------------------------"
gcloud scheduler jobs list --project=$PROJECT_ID --location=$REGION 2>&1 | grep -E "(NAME|stock)" || echo "⚠️  No stock-related scheduler jobs found or permission denied"
echo ""

echo "================================================"
echo "Useful Monitoring Commands:"
echo "================================================"
echo ""

echo "1. View recent Cloud Run service logs:"
echo "   gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE_NAME\"' \\"
echo "     --limit=50 --project=$PROJECT_ID --format=json"
echo ""

echo "2. View Cloud Run job execution logs:"
echo "   gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$SERVICE_NAME\"' \\"
echo "     --limit=50 --project=$PROJECT_ID --format=json"
echo ""

echo "3. View recent errors:"
echo "   gcloud logging read 'resource.type=\"cloud_run_revision\" AND severity>=ERROR' \\"
echo "     --limit=20 --project=$PROJECT_ID"
echo ""

echo "4. Check scheduler job status:"
echo "   gcloud scheduler jobs describe stock-price-daily-sync --location=$REGION --project=$PROJECT_ID"
echo ""

echo "5. Manually trigger scheduler job:"
echo "   gcloud scheduler jobs run stock-price-daily-sync --location=$REGION --project=$PROJECT_ID"
echo ""

echo "================================================"
echo "Database Monitoring Commands:"
echo "================================================"
echo ""

echo "1. Check recent stock data ingestion:"
echo "   psql \"\$DATABASE_URL\" -c 'SELECT * FROM stock_data_ingestion_log ORDER BY started_at DESC LIMIT 10;'"
echo ""

echo "2. Count stocks with data:"
echo "   psql \"\$DATABASE_URL\" -c 'SELECT COUNT(DISTINCT stock_code) FROM stock_prices;'"
echo ""

echo "3. Find stocks missing data:"
echo "   psql \"\$DATABASE_URL\" -c 'SELECT COUNT(*) FROM \"company-metadata\" WHERE stock_code NOT IN (SELECT DISTINCT stock_code FROM stock_prices);'"
echo ""

echo "4. Check recent data updates:"
echo "   psql \"\$DATABASE_URL\" -c 'SELECT stock_code, MAX(date) as latest_date FROM stock_prices GROUP BY stock_code ORDER BY latest_date DESC LIMIT 20;'"
echo ""

echo "================================================"
echo "To deploy the service (requires GCP permissions):"
echo "================================================"
echo "  cd services/stock-price-ingestion"
echo "  make deploy"
echo ""

