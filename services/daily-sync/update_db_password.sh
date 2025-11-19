#!/bin/bash
# Quick script to update the database password after resetting in Supabase

set -e

echo "🔐 Update Database Password for Daily Sync Job"
echo "=============================================="
echo ""

# Prompt for new password
read -sp "Enter new database password (from Supabase): " NEW_PASSWORD
echo ""

if [ -z "$NEW_PASSWORD" ]; then
    echo "❌ Password cannot be empty"
    exit 1
fi

# Construct connection string
CONNECTION_STRING="postgresql://postgres.xivfykscsdagwsreyqgf:${NEW_PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

echo ""
echo "📝 Updating secret in Google Cloud..."
echo -n "$CONNECTION_STRING" | \
gcloud secrets versions add COMPREHENSIVE_DAILY_SYNC_DATABASE_URL \
    --data-file=- \
    --project=shorted-dev-aba5688f

echo ""
echo "✅ Secret updated successfully!"
echo ""
echo "🧪 Testing connection with a job execution..."
echo ""

gcloud run jobs execute comprehensive-daily-sync \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f \
    --async

echo ""
echo "📋 Check logs in ~30 seconds:"
echo "   make daily-sync-logs"
echo ""
echo "Or visit:"
echo "   https://console.cloud.google.com/run/jobs/details/asia-northeast1/comprehensive-daily-sync"

