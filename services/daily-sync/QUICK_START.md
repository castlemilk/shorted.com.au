# Quick Start: Daily Sync with Alpha Vantage + Yahoo Fallback

## ✅ What You Have Now

A daily sync system that:
- **Primary**: Uses Alpha Vantage API (more reliable)
- **Fallback**: Uses Yahoo Finance (when Alpha fails)
- **Result**: ~95% success rate across all stocks

## 🚀 Deploy in 3 Steps

### Step 1: Get Alpha Vantage API Key (2 minutes)

Visit: https://www.alphavantage.co/support/#api-key
- Enter your email
- Get instant free key
- 500 requests/day (plenty for 107 stocks × 2 runs)

### Step 2: Set Environment Variables

```bash
# Required
export DATABASE_URL="postgresql://user:pass@host:port/database"

# Recommended (for better data quality)
export ALPHA_VANTAGE_API_KEY="your-key-here"

# Optional
export GCP_PROJECT="shorted-dev-aba5688f"
export GCP_REGION="asia-northeast1"
```

### Step 3: Deploy

```bash
make daily-sync-deploy
```

Done! The job will run daily at 2 AM AEST.

## 📊 What Happens

### With Alpha Vantage Key (Recommended):
- Duration: ~20 minutes
- Alpha Vantage: 85-90 stocks
- Yahoo Finance fallback: 10-15 stocks  
- Total success: ~100 stocks

### Without Alpha Vantage Key:
- Duration: ~3 minutes
- Yahoo Finance only: 80-85 stocks
- Failed: 20-25 stocks
- Total success: ~85 stocks

## ✅ Verify It's Working

```bash
# Execute now (test)
make daily-sync-execute

# View logs (check which provider used)
make daily-sync-logs

# Look for lines like:
# [  1/107] CBA: ✅ 5 records (Alpha Vantage)  ← Primary
# [  5/107] XYZ: ✅ 5 records (Yahoo Finance)   ← Fallback
```

## 🎯 Recommendations

**For Production**: Use Alpha Vantage
- Free tier is sufficient
- Better data quality
- Higher success rate
- Worth the 20-minute runtime

**For Development/Testing**: Yahoo Finance only is fine
- Faster (3 minutes)
- No API key needed
- Good enough for testing

## 📖 More Info

- Full guide: `../ALPHA_VANTAGE_DAILY_SYNC.md`
- Setup instructions: `../DAILY_SYNC_SETUP.md`
- Technical details: `README.md`

