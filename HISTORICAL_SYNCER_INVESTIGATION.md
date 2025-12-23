# Historical Market Data Syncer Investigation Results

## 🔍 Investigation Date: 2025-12-14

### Summary

**Status**: ⚠️ **SYNC JOBS ARE NOT COMPLETING**

The historical market data syncer (`comprehensive-daily-sync`) is **starting but not completing**. All recent sync runs are stuck in "running" status with 0 records updated.

---

## 📊 Current State

### Sync Status from Database

- **Total Stocks with Data**: 1,843 stocks
- **Stocks with Recent Data (7 days)**: 1,705 stocks
- **Latest Price Date**: 2025-12-13 (2 days ago)
- **Last Sync Attempt**: 1.9 hours ago (still marked as "running")
- **Last Successful Sync**: December 7, 2025 (7 days ago) ⚠️
- **Stuck Runs**: 50 runs in "running" status
- **Failed Runs**: 2 runs (both on December 7)

### Recent Sync Runs

All 10 most recent sync runs show:

- **Status**: `running` (never completed)
- **Records Updated**: 0 (both shorts and prices)
- **Environment**: `development`
- **Hostname**: `localhost`

This indicates:

1. ✅ Sync jobs are being triggered (every hour based on timestamps)
2. ❌ Sync jobs are starting but not completing
3. ❌ No records are being updated
4. ❌ Jobs are stuck in "running" status

---

## 🚨 Problems Identified

### 1. **Sync Jobs Not Completing**

All recent sync runs are stuck in "running" status:

- Started but never call `recorder.complete()`
- No error messages recorded
- 0 records updated

**Possible Causes**:

- Job is crashing before completion
- Exception not being caught/recorded
- Database connection issues
- Timeout issues
- Missing dependencies or environment variables

### 2. **No Completed Runs Since December 7**

**Last successful sync**: December 7, 2025 (7 days ago)

- Updated 5,087 price records
- Updated 16,219 shorts records

**Since then**: 50 runs stuck in "running" status

- Sync has been broken for **7 days**
- No successful completions since December 7

### 3. **Data Staleness**

- Latest price date is 2 days old
- While 1,705 stocks have recent data, this may be from manual runs or older successful syncs

---

## 🔧 Next Steps to Investigate

### 1. Check Cloud Run Job Logs

Since direct log access requires permissions, check via GCP Console:

- **Cloud Run Jobs**: https://console.cloud.google.com/run/jobs
- **Cloud Logging**: https://console.cloud.google.com/logs
- Filter for: `resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync`

### 2. Check for Error Patterns

Look for:

- Database connection errors
- API rate limiting (Alpha Vantage, Yahoo Finance)
- Timeout errors
- Missing environment variables
- Import/dependency errors

### 3. Check Job Configuration

Verify:

- Cloud Run Job is properly configured
- Environment variables are set (DATABASE_URL, ALPHA_VANTAGE_API_KEY)
- Memory/CPU limits are sufficient
- Timeout settings are appropriate

### 4. Manual Test Run

Test the sync locally to identify the issue:

```bash
cd services/daily-sync
export DATABASE_URL="your-database-url"
python3 comprehensive_daily_sync.py
```

### 5. Check for Stuck Processes

The fact that all runs show "running" suggests:

- Jobs may be timing out
- Database transactions may not be committing
- The `recorder.complete()` method may not be called

---

## 📋 Recommended Actions

1. **Immediate**: Check Cloud Run job logs to see why jobs are failing
2. **Short-term**: Fix the underlying issue preventing completion
3. **Medium-term**: Add better error handling and monitoring
4. **Long-term**: Consider deploying the dedicated `daily-historical-sync` job for full ASX coverage

---

## 🔗 Related Files

- **Sync Script**: `services/daily-sync/comprehensive_daily_sync.py`
- **Status Check Script**: `scripts/check-sync-status.py`
- **Deployment**: `services/daily-sync/deploy.sh`
- **Status Table**: `services/migrations/000006_add_sync_status.up.sql`

---

## 💡 Hypothesis

Based on the evidence, the most likely issues are:

1. **Job Timeout**: Jobs may be exceeding Cloud Run timeout limits
2. **Unhandled Exceptions**: Python exceptions may be crashing the job before completion
3. **Database Connection Issues**: Connection pool may be exhausted or timing out
4. **Missing Error Handling**: Errors may not be properly caught and recorded in `sync_status` table

The fact that all runs show 0 records and "running" status suggests the job is failing early in execution, before any data processing occurs.
