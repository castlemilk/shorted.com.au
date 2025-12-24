# How to Access Cloud Run Logs for Sync Jobs

## 🔍 Current Situation

I cannot directly access Cloud Run logs due to permission restrictions. However, you can access them through the GCP Console.

## 📋 Steps to Check Logs

### Option 1: GCP Console (Recommended)

1. **Open Cloud Logging**:

   - Go to: https://console.cloud.google.com/logs
   - Make sure you're in project: `shorted-dev-aba5688f`

2. **Filter for Sync Job Logs**:

   ```
   resource.type=cloud_run_job
   AND resource.labels.job_name=comprehensive-daily-sync
   ```

3. **Filter for Errors Only**:

   ```
   resource.type=cloud_run_job
   AND resource.labels.job_name=comprehensive-daily-sync
   AND severity>=ERROR
   ```

4. **Filter for Recent Runs** (last 24 hours):
   ```
   resource.type=cloud_run_job
   AND resource.labels.job_name=comprehensive-daily-sync
   AND timestamp>="2025-12-14T00:00:00Z"
   ```

### Option 2: gcloud CLI (If you have permissions)

```bash
# Recent logs
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
  --limit=50 \
  --project=shorted-dev-aba5688f \
  --format="table(timestamp,severity,textPayload)"

# Errors only
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync AND severity>=ERROR" \
  --limit=20 \
  --project=shorted-dev-aba5688f

# JSON format (for detailed analysis)
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
  --limit=50 \
  --project=shorted-dev-aba5688f \
  --format=json > sync-logs.json
```

### Option 3: Check Job Executions

1. **Open Cloud Run Jobs**:

   - Go to: https://console.cloud.google.com/run/jobs
   - Select: `comprehensive-daily-sync`
   - Click on "Executions" tab

2. **View Execution Details**:
   - Click on a recent execution
   - Check the "Logs" tab for error messages
   - Check the "Status" for completion state

## 🔍 What to Look For

### Common Issues:

1. **Database Connection Errors**:

   - Look for: `connection refused`, `timeout`, `authentication failed`
   - Check if `DATABASE_URL` is set correctly

2. **Import/Dependency Errors**:

   - Look for: `ModuleNotFoundError`, `ImportError`
   - Check if all Python packages are installed

3. **Timeout Errors**:

   - Look for: `timeout`, `deadline exceeded`
   - Check Cloud Run job timeout settings

4. **API Rate Limiting**:

   - Look for: `rate limit`, `429`, `too many requests`
   - Check Alpha Vantage and Yahoo Finance API limits

5. **Memory/Resource Errors**:

   - Look for: `out of memory`, `killed`, `OOM`
   - Check Cloud Run job memory limits

6. **Unhandled Exceptions**:
   - Look for: `Traceback`, `Exception`, `Error`
   - These will show the exact failure point

## 📊 Expected Log Pattern

A successful sync should show:

```
🚀 COMPREHENSIVE DAILY SYNC - STARTING
📊 Shorts sync: Last 7 days
💰 Stock prices sync: Last 5 days
...
✅ SYNC COMPLETE
📊 Shorts records updated: X
💰 Price records updated: Y
```

A failed sync might show:

```
🚀 COMPREHENSIVE DAILY SYNC - STARTING
...
❌ SYNC FAILED: [error message]
Traceback (most recent call last):
  ...
```

## 🧪 Alternative: Test Locally

If you can't access logs, test the sync locally:

```bash
./scripts/test-sync-locally.sh
```

This will:

- Run the sync script locally
- Show any errors in real-time
- Save logs to `/tmp/sync-test.log`
- Help identify the issue without Cloud Run

## 💡 Next Steps After Finding Errors

1. **Share the error message** from the logs
2. **Check the specific line** where it fails
3. **Review the code** around that line
4. **Fix the issue** and redeploy

---

**Note**: If you find errors in the logs, please share them so we can fix the issue!


