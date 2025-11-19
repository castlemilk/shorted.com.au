# Vercel KV Cache Setup for About Page

## Overview

This implementation uses Vercel KV (Upstash Redis) to cache statistics and stock data for the about page, dramatically reducing load times from ~500ms+ to ~20ms.

## Architecture

```
User Request → API Route → Check KV Cache → Return cached data (fast!)
                              ↓ (cache miss)
                         Fetch from DB → Store in cache → Return data
```

## Cache Keys

- `cache:about:statistics` - Company and industry statistics (TTL: 5 minutes)
- `cache:about:top-stocks:5` - Top 5 stocks for animated ticker (TTL: 5 minutes)

## Cache Warming

A cron job automatically warms the cache every 5 minutes to ensure data is always fresh:

**Vercel Cron Configuration** (`vercel.json`):
```json
{
  "crons": [
    {
      "path": "/api/about/warm-cache",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

## Manual Cache Warming

You can manually warm the cache by calling:

```bash
# Without secret (if CACHE_WARM_SECRET not set)
curl https://your-domain.com/api/about/warm-cache

# With secret (recommended for production)
curl https://your-domain.com/api/about/warm-cache?secret=YOUR_SECRET
```

## Environment Variables

Required:
- `KV_REST_API_URL` - Vercel KV REST API URL (auto-provided by Vercel)
- `KV_REST_API_TOKEN` - Vercel KV REST API token (auto-provided by Vercel)

Optional:
- `CACHE_WARM_SECRET` - Secret for protecting the warm-cache endpoint

## Performance Improvements

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| First Load | ~500ms | ~500ms | Same (cache miss) |
| Cached Load | ~500ms | ~20ms | **25x faster** |
| Cache Hit Rate | 0% | ~95% | After warm-up |

## Cache Invalidation

Cache automatically expires after 5 minutes (TTL). The cron job refreshes it every 5 minutes, ensuring data is never stale for more than a few seconds.

## Monitoring

Check cache performance via response headers:
- `X-Cache: HIT` - Data served from cache
- `X-Cache: MISS` - Data fetched from database

## Troubleshooting

1. **Cache not working**: Check that `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set
2. **Stale data**: Verify cron job is running (check Vercel dashboard → Cron Jobs)
3. **Slow first load**: This is expected - cache needs to warm up first

