# Testing KV Cache Optimization

## Overview

This document describes how to test the KV cache optimization for homepage performance.

## Test Suite

### Unit Tests

#### 1. KV Cache Library Tests (`src/@/lib/__tests__/kv-cache.test.ts`)

Tests the core cache functionality:
- Cache key generation
- Setting and getting cached data
- Cache expiration
- `getOrSetCached` helper function
- Cache availability checks

**Run:**
```bash
npm test -- kv-cache.test.ts
```

#### 2. Server Action Cache Tests (`src/app/actions/__tests__/getTopShorts-cache.test.ts`)

Tests that server actions use cache correctly:
- Cache key generation
- Cache hit scenarios
- Cache miss scenarios (API fallback)
- Different parameter combinations

**Run:**
```bash
npm test -- getTopShorts-cache.test.ts
```

#### 3. Cache Warming Endpoint Tests (`src/app/api/homepage/__tests__/warm-cache.test.ts`)

Tests the cache warming API endpoint:
- Successful cache warming
- Multiple periods warming
- Error handling
- Secret protection
- Duration and timestamp reporting

**Run:**
```bash
npm test -- warm-cache.test.ts
```

#### 4. Homepage Server Component Tests (`src/app/__tests__/page-server.test.tsx`)

Tests the server component:
- Data fetching from cache
- Parallel data fetching
- Error handling
- Props passing to client component

**Run:**
```bash
npm test -- page-server.test.tsx
```

## Integration Tests

### Manual Testing

#### 1. Test Cache Warming Endpoint

```bash
# Without secret (if CACHE_WARM_SECRET not set)
curl http://localhost:3020/api/homepage/warm-cache

# With secret (if CACHE_WARM_SECRET is set)
curl "http://localhost:3020/api/homepage/warm-cache?secret=YOUR_SECRET"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Cache warmed: 5/5 successful",
  "results": {
    "top-shorts-3m": { "success": true },
    "treemap-3m": { "success": true },
    "top-shorts-1m": { "success": true },
    "top-shorts-6m": { "success": true },
    "top-shorts-1y": { "success": true }
  },
  "duration": "1234ms",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### 2. Test Cache Hit/Miss Behavior

**First Request (Cache Miss):**
```bash
# Start server
npm run start

# Make request - should fetch from API
curl http://localhost:3020/ | grep -o "top-shorts-data"
```

**Second Request (Cache Hit):**
```bash
# Make same request - should use cache
curl http://localhost:3020/ | grep -o "top-shorts-data"
```

**Check Server Logs:**
- First request: Should see API calls
- Second request: Should see cache hits (no API calls)

#### 3. Test Cache Expiration

```bash
# Warm cache
curl http://localhost:3020/api/homepage/warm-cache

# Wait for TTL to expire (10 minutes for homepage)
# Or manually delete cache key in Redis

# Make request - should fetch from API again
curl http://localhost:3020/
```

#### 4. Test Performance Improvement

**Before Cache (Cold Start):**
```bash
# Clear cache or wait for expiration
# Make request and measure time
time curl http://localhost:3020/ > /dev/null
# Expected: ~500ms+
```

**After Cache (Warm):**
```bash
# Warm cache first
curl http://localhost:3020/api/homepage/warm-cache

# Make request and measure time
time curl http://localhost:3020/ > /dev/null
# Expected: ~20ms
```

## E2E Testing with Lighthouse

### Test Performance Improvements

```bash
# Build and start production server
npm run build
npm run start

# In another terminal, run Lighthouse
npx lighthouse http://localhost:3020 \
  --only-categories=performance \
  --output=json \
  --output-path=./lighthouse-before.json

# Warm cache
curl http://localhost:3020/api/homepage/warm-cache

# Run Lighthouse again
npx lighthouse http://localhost:3020 \
  --only-categories=performance \
  --output=json \
  --output-path=./lighthouse-after.json

# Compare results
```

**Expected Improvements:**
- LCP: 29.7s → < 2.5s
- FCP: 6.5s → < 1.8s
- Server Response Time: ~500ms → ~20ms

## Monitoring Cache Performance

### Check Cache Hit Rate

Add logging to monitor cache performance:

```typescript
// In kv-cache.ts
export async function getCached<T>(key: string): Promise<T | null> {
  const cached = await redis.get<T>(key);
  if (cached !== null) {
    console.log(`[CACHE HIT] ${key}`);
  } else {
    console.log(`[CACHE MISS] ${key}`);
  }
  return cached;
}
```

### Monitor Cache Keys

```bash
# If you have Redis CLI access
redis-cli
> KEYS cache:homepage:*
> TTL cache:homepage:top-shorts:3m:50:0
> GET cache:homepage:top-shorts:3m:50:0
```

## Testing Cron Job

### Local Testing

Vercel cron jobs don't run locally, but you can test the endpoint:

```bash
# Simulate cron job call
curl http://localhost:3020/api/homepage/warm-cache
```

### Production Testing

1. Deploy to Vercel
2. Check Vercel logs for cron job execution
3. Verify cache is warmed every 10 minutes

## Test Scenarios

### Scenario 1: Cold Start (No Cache)

1. Clear all cache keys
2. Make homepage request
3. Verify:
   - API calls are made
   - Data is cached
   - Response time is slower (~500ms)

### Scenario 2: Warm Cache

1. Warm cache via endpoint
2. Make homepage request
3. Verify:
   - No API calls (cache hit)
   - Response time is fast (~20ms)
   - Data is correct

### Scenario 3: Cache Expiration

1. Warm cache
2. Wait for TTL to expire (10 minutes)
3. Make homepage request
4. Verify:
   - Cache miss occurs
   - API call is made
   - New data is cached

### Scenario 4: Error Handling

1. Simulate API failure
2. Make homepage request
3. Verify:
   - Error is handled gracefully
   - Page still renders (with empty data)
   - No crash occurs

### Scenario 5: Concurrent Requests

1. Warm cache
2. Make multiple concurrent requests
3. Verify:
   - All requests use cache
   - No duplicate API calls
   - Fast response times

## Running All Tests

```bash
# Run all tests
npm test

# Run cache-related tests only
npm test -- --testPathPattern="cache|warm-cache|page-server"

# Run with coverage
npm test -- --coverage --testPathPattern="cache|warm-cache|page-server"
```

## Continuous Integration

Add to CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Test Cache Functionality
  run: |
    npm test -- --testPathPattern="cache|warm-cache|page-server"
    npm run build
    npm run start &
    sleep 5
    curl http://localhost:3020/api/homepage/warm-cache
    curl http://localhost:3020/
```

## Troubleshooting

### Cache Not Working

1. Check environment variables:
   ```bash
   echo $KV_REST_API_URL
   echo $KV_REST_API_TOKEN
   ```

2. Check Redis connection:
   ```typescript
   import { isCacheAvailable } from "~/@/lib/kv-cache";
   console.log("Cache available:", isCacheAvailable());
   ```

3. Check cache keys:
   ```bash
   # In Redis CLI
   KEYS cache:homepage:*
   ```

### Tests Failing

1. Clear Jest cache:
   ```bash
   npm test -- --clearCache
   ```

2. Reset modules:
   ```bash
   jest.resetModules()
   ```

3. Check mocks are properly set up

## Performance Benchmarks

### Expected Metrics

| Scenario | Response Time | Cache Hit Rate |
|----------|---------------|----------------|
| Cold Start | ~500ms | 0% |
| Warm Cache | ~20ms | 95%+ |
| After Cron | ~20ms | 95%+ |

### Monitoring

Set up monitoring to track:
- Cache hit rate
- Average response time
- Cache warming success rate
- API call reduction

