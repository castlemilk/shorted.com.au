# Alpha Vantage + Yahoo Finance Dual-Provider Setup

## 🎯 Strategy

The daily sync uses a **dual-provider approach** for maximum reliability:

1. **🔑 Alpha Vantage (Primary)** - Premium, reliable data
2. **🌐 Yahoo Finance (Fallback)** - Free, unlimited as backup

## 🚀 Quick Start

### Option 1: With Alpha Vantage (Recommended)

```bash
# Get your free Alpha Vantage API key
# Visit: https://www.alphavantage.co/support/#api-key

# Set environment variables
export DATABASE_URL="postgresql://..."
export ALPHA_VANTAGE_API_KEY="your_api_key_here"

# Deploy
make daily-sync-deploy
```

### Option 2: Yahoo Finance Only

```bash
# Just set database URL (no API key needed)
export DATABASE_URL="postgresql://..."

# Deploy (will use Yahoo Finance only)
make daily-sync-deploy
```

## 📊 How It Works

### Request Flow

```
For each stock:
  1. Try Alpha Vantage
     ├─ Success? ✅ Use data (12s delay)
     └─ Failed?  ⬇️  Try Yahoo Finance
  
  2. Try Yahoo Finance
     ├─ Success? ✅ Use data (0.3s delay)
     └─ Failed?  ❌ Mark as failed, continue
```

### Rate Limiting

| Provider | Rate Limit | Delay | 107 Stocks Time |
|----------|------------|-------|-----------------|
| **Alpha Vantage** | 5/min | 12s | ~21 minutes |
| **Yahoo Finance** | Generous | 0.3s | ~32 seconds |
| **Mixed (typical)** | Both | Variable | ~5-10 minutes |

**Typical scenario**: 80% Alpha Vantage, 20% Yahoo Finance = ~17 minutes

## 🔑 Alpha Vantage API Key

### Get a Free Key

1. Visit: https://www.alphavantage.co/support/#api-key
2. Enter your email
3. Receive key instantly
4. Free tier: **500 requests/day**, **5 requests/minute**

### Sufficient for Daily Sync

- **Daily usage**: 107 stocks × 1 request = 107 requests
- **Free limit**: 500 requests/day
- **Buffer**: ~393 requests remaining for other uses
- **Verdict**: ✅ More than enough!

## 📈 Provider Comparison

### Alpha Vantage ✅

**Pros:**
- ✅ More reliable
- ✅ Better data quality
- ✅ Official API with SLA
- ✅ Handles ASX stocks well
- ✅ Better for automated systems

**Cons:**
- ⚠️ Requires API key (free)
- ⚠️ Rate limited (5/min)
- ⚠️ Slower (12s delay)

### Yahoo Finance 🌐

**Pros:**
- ✅ No API key needed
- ✅ Unlimited requests
- ✅ Fast (0.3s delay)
- ✅ Works for most stocks

**Cons:**
- ⚠️ Less reliable
- ⚠️ Unofficial API
- ⚠️ Some ASX stocks missing
- ⚠️ Can break without notice

## 🎭 Best of Both Worlds

**Our strategy gets you:**
- ✅ **Reliability**: Primary source is official Alpha Vantage
- ✅ **Coverage**: Yahoo Finance catches stocks Alpha Vantage misses
- ✅ **Resilience**: If Alpha Vantage fails, Yahoo continues
- ✅ **Performance**: Fast Yahoo for what works, reliable Alpha for what matters

## 📊 Expected Results

### With Alpha Vantage API Key

```
🔑 Alpha Vantage API key detected - will use as primary source
🔄 Yahoo Finance configured as fallback
🔄 Updating 107 stocks with last 5 days of data

[  1/107] CBA: ✅ 5 records (🔑 Alpha Vantage)
[  2/107] BHP: ✅ 5 records (🔑 Alpha Vantage)
[  3/107] WBC: ✅ 5 records (🔑 Alpha Vantage)
...
[ 98/107] XYZ: ✅ 5 records (🌐 Yahoo Finance)  # Fallback
...

✅ Stock prices update complete:
   Successful: 87
   Failed: 20
   🔑 Alpha Vantage: 70
   🌐 Yahoo Finance: 17
   Total records: 435
```

### Without Alpha Vantage API Key

```
⚠️  No Alpha Vantage API key - using Yahoo Finance only
🔄 Updating 107 stocks with last 5 days of data

[  1/107] CBA: ✅ 5 records (🌐 Yahoo Finance)
[  2/107] BHP: ✅ 5 records (🌐 Yahoo Finance)
...

✅ Stock prices update complete:
   Successful: 87
   Failed: 20
   Total records: 435
```

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ Yes | - | PostgreSQL connection |
| `ALPHA_VANTAGE_API_KEY` | ⚠️ Optional | None | Alpha Vantage API key |
| `SYNC_DAYS_STOCK_PRICES` | ❌ No | 5 | Days of stock data to sync |
| `SYNC_DAYS_SHORTS` | ❌ No | 7 | Days of shorts data to sync |

### Set API Key in Cloud Run

```bash
# During deployment
export ALPHA_VANTAGE_API_KEY="your_key_here"
make daily-sync-deploy

# Update existing job
gcloud run jobs update comprehensive-daily-sync \
    --set-env-vars ALPHA_VANTAGE_API_KEY="your_key_here" \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f
```

### Use Secret Manager (Recommended for Production)

```bash
# Create secret
echo -n "your_api_key" | gcloud secrets create ALPHA_VANTAGE_API_KEY \
    --data-file=- \
    --project shorted-dev-aba5688f

# Update job to use secret
gcloud run jobs update comprehensive-daily-sync \
    --update-secrets ALPHA_VANTAGE_API_KEY=ALPHA_VANTAGE_API_KEY:latest \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f
```

## 🔍 Monitoring

### Check Which Provider is Being Used

```bash
# View recent logs
make daily-sync-logs | grep "records ("

# Look for:
# 🔑 Alpha Vantage = Primary source used
# 🌐 Yahoo Finance = Fallback used
```

### Verify Alpha Vantage is Working

```bash
# If you see mostly "🔑 Alpha Vantage" in logs: ✅ Working
# If you see mostly "🌐 Yahoo Finance": ⚠️ Check API key
```

### Check Rate Limit Usage

Alpha Vantage dashboard: https://www.alphavantage.co/

- View daily usage
- Monitor remaining quota
- Track request patterns

## 🆘 Troubleshooting

### Only Yahoo Finance is Used (No Alpha Vantage)

**Check:**
1. Is `ALPHA_VANTAGE_API_KEY` environment variable set?
   ```bash
   gcloud run jobs describe comprehensive-daily-sync \
       --region asia-northeast1 | grep ALPHA_VANTAGE
   ```

2. Is the API key valid?
   ```bash
   curl "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=CBA.AX&apikey=YOUR_KEY"
   ```

3. Check logs for errors:
   ```bash
   make daily-sync-logs | grep -i "alpha vantage"
   ```

### Rate Limit Errors

If you see `⚠️  Alpha Vantage rate limit hit`:

- Normal! The script automatically falls back to Yahoo Finance
- Rate limit: 5 requests/minute
- The 12-second delay should prevent this
- If frequent, might indicate parallel requests

### Both Providers Failing

If a stock fails from both providers:

1. **Stock might be delisted** - Normal
2. **Symbol format issue** - Check if `.AX` suffix is correct
3. **Market closed** - Weekend/holiday, no new data

## 💰 Cost Analysis

### Alpha Vantage Free Tier

- **Daily usage**: ~107 requests
- **Free limit**: 500 requests/day
- **Cost**: $0 (free tier sufficient)

### Upgrade If Needed

If you exceed free tier limits:

- **Premium plan**: $49.99/month
- **Unlimited requests**
- **Priority support**

**For our use case**: Free tier is more than enough!

## 🎉 Summary

**With Alpha Vantage API Key:**
- ✅ Best reliability and data quality
- ✅ Automatic fallback to Yahoo
- ✅ Free tier is sufficient
- ⏱️ ~17 minutes for full sync

**Without API Key:**
- ✅ Still works (Yahoo only)
- ⚠️ Less reliable
- ⚠️ Some stocks may fail more often
- ⏱️ ~32 seconds for full sync

**Recommendation**: **Get the free Alpha Vantage API key** for better reliability! Takes 30 seconds to sign up.

