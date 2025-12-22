# Sync Timeout Fix

## 🔍 Root Cause Identified

**Problem**: The comprehensive daily sync job is timing out in Cloud Run because:

- Processing 1,843 stocks sequentially takes ~45-60 minutes
- Cloud Run has a maximum timeout of 3600 seconds (1 hour)
- When the job times out, it's killed before `recorder.complete()` is called
- Status remains "running" instead of being marked as "failed"

## ✅ Fix Applied

### 1. **Timeout Detection**

Added signal handlers to detect when Cloud Run sends SIGTERM (timeout):

- Catches termination signals
- Marks job as "failed" with timeout message before exit
- Prevents jobs from staying in "running" status

### 2. **Periodic Termination Checks**

Added checks throughout the sync process:

- After shorts data update
- After stock price update
- Before final completion
- Allows graceful shutdown if timeout is approaching

## 📝 Changes Made

1. **Signal Handling** (`comprehensive_daily_sync.py`):

   - Added `handle_timeout()` function to catch SIGTERM/SIGINT
   - Sets global `_terminating` flag
   - Attempts to mark job as failed before exit

2. **Termination Checks**:

   - Check `_terminating` flag after major operations
   - Abort gracefully if termination signal received
   - Update status to "failed" with appropriate message

3. **Deploy Script**:
   - Updated timeout format to `3600s` (already at maximum)

## 🚀 Next Steps

1. **Deploy the fix**:

   ```bash
   cd services/daily-sync
   export DATABASE_URL="your-database-url"
   ./deploy.sh
   ```

2. **Monitor the next run**:

   - Check if jobs now complete or are properly marked as failed
   - Verify timeout detection works

3. **Long-term Optimization** (if needed):
   - Process stocks in parallel batches
   - Skip stocks that are already up-to-date more efficiently
   - Consider splitting into multiple smaller jobs

## 📊 Expected Behavior After Fix

- ✅ Jobs that complete successfully: Status = "completed"
- ✅ Jobs that timeout: Status = "failed" with error "Job terminated due to timeout"
- ❌ No more jobs stuck in "running" status

## ⚠️ Note

The timeout is still 1 hour (maximum for Cloud Run). If the sync consistently takes longer than 1 hour, consider:

- Processing stocks in parallel
- Reducing the number of stocks processed per run
- Splitting into multiple jobs

