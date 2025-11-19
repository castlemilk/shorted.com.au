# Daily Sync Quick Reference 🚀

## ✅ Status: DEPLOYED & RUNNING

Your intelligent daily sync is live and will run automatically every night at **2 AM AEST**.

## 📋 Handy Commands

```bash
# View recent logs
make daily-sync-logs

# Check scheduler status
make daily-sync-status

# Execute job manually (for testing)
make daily-sync-execute

# Run tests
make daily-sync-test

# Run locally (for development)
make daily-sync-local
```

## 🔍 Direct GCloud Commands

```bash
# View logs (more control)
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
  --limit 50 \
  --project shorted-dev-aba5688f

# Check execution history
gcloud run jobs executions list \
  --job comprehensive-daily-sync \
  --region asia-northeast1 \
  --project shorted-dev-aba5688f

# View scheduler details
gcloud scheduler jobs describe comprehensive-daily-sync-trigger \
  --location asia-northeast1 \
  --project shorted-dev-aba5688f
```

## 📊 What It Does

**Every night at 2 AM AEST:**

1. **Shorts Data Sync**
   - Checks last ingested date
   - Fetches missing ASIC data
   - Updates `shorts` table

2. **Stock Prices Sync**
   - For each stock:
     - Check last price date
     - Calculate days to fetch
     - Try Alpha Vantage (primary)
     - Fallback to Yahoo Finance
     - Skip if already current
   - Updates `stock_prices` table

## 🎯 Key Features

✅ **Intelligent** - Only fetches missing data
✅ **Reliable** - Dual-provider failover  
✅ **Efficient** - Skips up-to-date stocks
✅ **Resilient** - Auto-retries on failure
✅ **Monitored** - Full logging to Cloud Logging

## 📈 Monitoring

### Success Indicators
- Logs show "✅ complete"
- No authentication errors
- Alpha Vantage + Yahoo counts > 0
- "Already up-to-date" count increases over time

### Warning Signs
- All stocks show "No data from any source"
- Job timeout (>1 hour)
- Repeated authentication failures

## 🔧 Troubleshooting

### Job fails to connect
```bash
# Check secret
gcloud secrets versions access latest \
  --secret=COMPREHENSIVE_DAILY_SYNC_DATABASE_URL \
  --project=shorted-dev-aba5688f
```

### Need to update database password
```bash
cd services/daily-sync
./update_db_password.sh
```

### Redeploy after code changes
```bash
make daily-sync-deploy
```

## 📂 Important Files

- `services/daily-sync/comprehensive_daily_sync.py` - Main sync logic
- `services/daily-sync/Dockerfile` - Container definition
- `services/daily-sync/deploy.sh` - Deployment script
- `services/daily-sync/requirements.txt` - Python dependencies

## 🌐 Console Links

- [Cloud Run Job](https://console.cloud.google.com/run/jobs/details/asia-northeast1/comprehensive-daily-sync?project=shorted-dev-aba5688f)
- [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler?project=shorted-dev-aba5688f)
- [Logs Explorer](https://console.cloud.google.com/logs/query?project=shorted-dev-aba5688f)
- [Secrets Manager](https://console.cloud.google.com/security/secret-manager?project=shorted-dev-aba5688f)

---

**Status**: ✅ Deployed and Running  
**Last Updated**: November 13, 2025  
**Next Run**: Tonight at 2:00 AM AEST
