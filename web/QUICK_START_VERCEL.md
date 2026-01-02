# Quick Start: Vercel Edge Rate Limiting

## 🚀 5-Minute Setup

### 1. Create Vercel KV Database (2 min)

```bash
# Go to: https://vercel.com/dashboard
# 1. Click "Storage"
# 2. Click "Create Database"
# 3. Select "KV"
# 4. Name: shorted-rate-limit
# 5. Region: Sydney (syd1)
# 6. Click "Create"
```

### 2. Connect to Your Project (1 min)

```bash
# In Vercel Dashboard:
# 1. Go to your project
# 2. Click "Storage" tab
# 3. Click "Connect Store"
# 4. Select "shorted-rate-limit"
# 5. Click "Connect"
```

### 3. Deploy (2 min)

```bash
git add .
git commit -m "Add Vercel Edge rate limiting"
git push origin main
```

That's it! ✅ Your API now has edge rate limiting.

## 🧪 Test It

### Test Anonymous User (20 req/min)

```bash
# Make 25 requests quickly
for i in {1..25}; do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" \
    https://your-app.vercel.app/api/search/stocks?q=CBA
done

# Expected:
# Request 1-20: 200
# Request 21-25: 429 ← Rate limited!
```

### Check Headers

```bash
curl -I https://your-app.vercel.app/api/search/stocks?q=CBA
```

Look for:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 2025-01-15T10:30:00.000Z
```

## 📊 Monitor

### View Usage

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **Storage** → Your KV database
3. Click **Usage** tab

### View Logs

```bash
# Install Vercel CLI
npm i -g vercel

# View logs
vercel logs --follow
```

## ⚙️ Adjust Limits

Edit `src/middleware.ts`:

```typescript
// Anonymous: 20 → 50 requests per minute
anonymousLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(50, "60 s"),
  // ...
});

// Authenticated: 200 → 500 requests per minute
authenticatedLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(500, "60 s"),
  // ...
});
```

Then deploy:

```bash
git push
```

## 💰 Cost

| Traffic        | KV Operations | Cost     |
| -------------- | ------------- | -------- |
| 100k req/month | 200k          | **Free** |
| 500k req/month | 1M            | **Free** |
| 5M req/month   | 10M           | $2/month |

## 🔧 Local Development

### Option 1: Without KV (Simple)

```bash
npm run dev
# Rate limiting disabled, but app works fine
```

### Option 2: With KV (Full Testing)

```bash
# Create dev KV in Vercel Dashboard
# Copy credentials to .env.local:
KV_REST_API_URL=your-dev-url
KV_REST_API_TOKEN=your-dev-token

npm run dev
# Rate limiting enabled locally
```

## 📚 Full Documentation

- [Complete Setup Guide](./VERCEL_SETUP.md)
- [Implementation Details](./EDGE_RATE_LIMITING_COMPLETE.md)
- [Rate Limiting Analysis](./SSR_AND_RATE_LIMITING_ANALYSIS.md)

## ❓ FAQ

### Q: Do I need to pay for Vercel KV?

**A:** Free tier includes 10k requests/day. Pro plan includes 1M/month. Most apps stay under these limits.

### Q: What happens if KV is down?

**A:** The middleware has error handling - requests are allowed through if KV fails (graceful degradation).

### Q: Can I test locally without KV?

**A:** Yes! The app works fine without KV. Rate limiting is just disabled in development.

### Q: How do I see who's getting rate limited?

**A:** Check Vercel logs:

```bash
vercel logs | grep "Rate limit exceeded"
```

### Q: Can I have different limits per endpoint?

**A:** Yes! See [customization guide](./EDGE_RATE_LIMITING_COMPLETE.md#customizing-rate-limits).

## 🆘 Troubleshooting

### Rate limiting not working?

1. **Check KV is connected**:

   - Vercel Dashboard → Storage → Should show "Connected"

2. **Check environment variables**:

   - Vercel Dashboard → Settings → Environment Variables
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN` should exist

3. **Check deployment logs**:
   ```bash
   vercel logs
   ```

### Getting 429 errors immediately?

Limits might be too strict. Increase them in `src/middleware.ts`.

### KV costs too high?

1. Reduce analytics: `analytics: false`
2. Use fixed window: `Ratelimit.fixedWindow()`
3. Increase window size: `"300 s"` instead of `"60 s"`

## ✅ Success Checklist

- [ ] KV database created in Vercel
- [ ] KV connected to project
- [ ] Code deployed to Vercel
- [ ] Tested rate limiting (25 requests)
- [ ] Verified headers show rate limits
- [ ] Monitoring set up in dashboard

---

**Need help?** Check the [full documentation](./EDGE_RATE_LIMITING_COMPLETE.md) or [Vercel support](https://vercel.com/support).
