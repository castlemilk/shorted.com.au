# Testing Guide for KV Cache Optimization

## Quick Start

### Run All Cache Tests

```bash
# Unit tests
npm run test:cache

# Manual integration test
npm run test:cache:manual
```

## Test Coverage

### ✅ Unit Tests

1. **KV Cache Library** (`src/@/lib/__tests__/kv-cache.test.ts`)
   - Cache key generation
   - Set/get operations
   - Cache expiration
   - `getOrSetCached` helper

2. **Server Actions** (`src/app/actions/__tests__/getTopShorts-cache.test.ts`)
   - Cache integration
   - Cache hit/miss scenarios

3. **Cache Warming Endpoint** (`src/app/api/homepage/__tests__/warm-cache.test.ts`)
   - Endpoint functionality
   - Secret protection, for every warm route (`src/app/api/__tests__/warm-auth.test.ts`, `src/@/lib/__tests__/cache-warm-auth.test.ts`)
   - Error handling

4. **Homepage Server Component** (`src/app/__tests__/page-server.test.tsx`)
   - Server-side data fetching
   - Props passing
   - Error handling

### ✅ Integration Tests

**Manual Testing Script** (`scripts/test-cache.sh`):
- Cache warming endpoint
- Cache hit performance
- Concurrent requests
- Cache key verification

## Running Tests

### All Cache Tests
```bash
npm run test:cache
```

### Specific Test File
```bash
npm test -- kv-cache.test.ts
npm test -- warm-cache.test.ts
npm test -- page-server.test.tsx
```

### With Coverage
```bash
npm run test:coverage -- --testPathPattern="cache"
```

### Manual Integration Test
```bash
# Requires server running
npm run start
# In another terminal:
npm run test:cache:manual
```

## Test Scenarios

### 1. Cache Warming

```bash
# Test cache warming endpoint (off Vercel, with no warm credential configured)
curl http://localhost:3020/api/homepage/warm-cache

# Expected: Success response with all cache operations

# With CRON_SECRET or REVALIDATION_SECRET set on the server, send it as a bearer
curl -H "Authorization: Bearer $REVALIDATION_SECRET" http://localhost:3020/api/homepage/warm-cache

# With CACHE_WARM_SECRET set on the server, send it in the X-Cache-Warm-Secret header
curl -H "X-Cache-Warm-Secret: $CACHE_WARM_SECRET" http://localhost:3020/api/homepage/warm-cache
```

### 2. Cache Hit Performance

```bash
# First request (cache miss)
time curl http://localhost:3020/ > /dev/null
# Expected: ~500ms

# Second request (cache hit)
time curl http://localhost:3020/ > /dev/null
# Expected: ~20ms
```

### 3. Cache Expiration

```bash
# Warm cache
curl http://localhost:3020/api/homepage/warm-cache

# Wait 10 minutes (or manually expire in Redis)
# Then test - should fetch from API again
```

### 4. Error Handling

```bash
# With a warm secret configured, a wrong header is refused
curl -H "X-Cache-Warm-Secret: wrong" http://localhost:3020/api/homepage/warm-cache
# Expected: 401 Unauthorized

# A query-string secret is never accepted, even a correct one (CACHE_WARM_SECRET set on the server)
curl "http://localhost:3020/api/homepage/warm-cache?secret=$CACHE_WARM_SECRET"
# Expected: 401 Unauthorized
```

## Performance Testing

### Lighthouse Comparison

```bash
# Before cache
npm run build
npm run start &
sleep 5
npx lighthouse http://localhost:3020 --only-categories=performance --output=json > before.json

# Warm cache
curl http://localhost:3020/api/homepage/warm-cache

# After cache
npx lighthouse http://localhost:3020 --only-categories=performance --output=json > after.json

# Compare
jq '.categories.performance.score' before.json after.json
```

### Expected Results

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| LCP | 29.7s | < 2.5s | ✅ |
| FCP | 6.5s | < 1.8s | ✅ |
| Performance | 55% | 85%+ | ✅ |

## Monitoring

### Check Cache Hit Rate

Add to your monitoring:
```typescript
// Log cache hits/misses
console.log(`[CACHE] ${isHit ? 'HIT' : 'MISS'} ${key}`);
```

### Verify Cache Keys

If you have Redis access:
```bash
redis-cli
> KEYS cache:homepage:*
> TTL cache:homepage:top-shorts:3m:50:0
```

## Troubleshooting

### Tests Failing

1. Clear Jest cache:
   ```bash
   npm test -- --clearCache
   ```

2. Check environment variables:
   ```bash
   echo $KV_REST_API_URL
   echo $KV_REST_API_TOKEN
   ```

3. Reset modules in tests:
   ```typescript
   jest.resetModules()
   ```

### Cache Not Working

1. Verify KV is configured:
   ```typescript
   import { isCacheAvailable } from "~/@/lib/kv-cache";
   console.log("Cache available:", isCacheAvailable());
   ```

2. Check server logs for cache operations

3. Verify cron job is running (in production)

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Test Cache Functionality
  run: |
    npm run test:cache
    npm run build
    npm run start &
    sleep 5
    curl http://localhost:3020/api/homepage/warm-cache
    npm run test:cache:manual
```

## Next Steps

1. ✅ Unit tests created
2. ✅ Integration test script created
3. ⏳ Add monitoring/logging
4. ⏳ Set up CI/CD integration
5. ⏳ Performance benchmarking

