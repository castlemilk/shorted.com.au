# How to Test KV Cache Optimization

## Quick Start

### Run All Cache Tests
```bash
npm run test:cache
```

### Manual Integration Test
```bash
# Start server
npm run start

# In another terminal, run test script
npm run test:cache:manual
```

## Test Files Created

### ✅ Unit Tests

1. **`src/@/lib/__tests__/kv-cache.test.ts`**
   - Tests core cache functionality
   - Cache key generation
   - Set/get/delete operations
   - Cache expiration
   - `getOrSetCached` helper

2. **`src/app/actions/__tests__/getTopShorts-cache.test.ts`**
   - Tests server action cache integration
   - Cache hit/miss scenarios
   - API fallback behavior

3. **`src/app/api/homepage/__tests__/warm-cache.test.ts`**
   - Tests cache warming endpoint
   - Secret protection
   - Error handling
   - Multiple periods

4. **`src/app/__tests__/page-server.test.tsx`**
   - Tests homepage server component
   - Server-side data fetching
   - Props passing

### ✅ Integration Test Script

**`scripts/test-cache.sh`**
- Automated integration testing
- Cache warming verification
- Performance measurement
- Concurrent request testing

## Testing Scenarios

### 1. Unit Tests

```bash
# Run all cache unit tests
npm run test:cache

# Run specific test file
npm test -- kv-cache.test.ts
npm test -- warm-cache.test.ts
npm test -- page-server.test.tsx
```

### 2. Manual Testing

#### Test Cache Warming
```bash
curl http://localhost:3020/api/homepage/warm-cache
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Cache warmed: 5/5 successful",
  "results": {
    "top-shorts-3m": { "success": true },
    "treemap-3m": { "success": true },
    ...
  },
  "duration": "1234ms"
}
```

#### Test Cache Performance

**Cold Start (Cache Miss):**
```bash
# Clear cache or wait for expiration
time curl http://localhost:3020/ > /dev/null
# Expected: ~500ms+
```

**Warm Cache (Cache Hit):**
```bash
# Warm cache first
curl http://localhost:3020/api/homepage/warm-cache

# Then test
time curl http://localhost:3020/ > /dev/null
# Expected: ~20ms
```

### 3. Lighthouse Performance Test

```bash
# Build and start
npm run build
npm run start &

# Warm cache
curl http://localhost:3020/api/homepage/warm-cache

# Run Lighthouse
npx lighthouse http://localhost:3020 \
  --only-categories=performance \
  --output=json \
  --output-path=./lighthouse-cached.json

# Compare with previous results
```

**Expected Improvements:**
- LCP: 29.7s → < 2.5s ✅
- FCP: 6.5s → < 1.8s ✅
- Performance Score: 55% → 85%+ ✅

## Test Coverage

### What's Tested

✅ **Cache Operations**
- Setting and getting cached data
- Cache expiration (TTL)
- Cache key generation
- Cache deletion
- Cache availability checks

✅ **Server Actions**
- Cache-first pattern
- API fallback on cache miss
- Different parameter combinations
- Error handling

✅ **Cache Warming**
- Endpoint functionality
- Multiple periods (1m, 3m, 6m, 1y)
- Error handling
- Secret protection

✅ **Homepage Component**
- Server-side data fetching
- Props passing to client component
- Parallel data fetching
- Error handling

## Monitoring

### Check Cache Hit Rate

Add logging to monitor cache performance:

```typescript
// In production, add metrics
console.log(`[CACHE] ${isHit ? 'HIT' : 'MISS'} ${key}`);
```

### Verify Cache Keys

If you have Redis CLI access:
```bash
redis-cli
> KEYS cache:homepage:*
> TTL cache:homepage:top-shorts:3m:50:0
```

## Troubleshooting

### Tests Failing

1. **Clear Jest cache:**
   ```bash
   npm test -- --clearCache
   ```

2. **Check environment variables:**
   ```bash
   echo $KV_REST_API_URL
   echo $KV_REST_API_TOKEN
   ```

3. **Reset modules in tests:**
   ```typescript
   jest.resetModules()
   ```

### Cache Not Working

1. **Verify KV is configured:**
   ```typescript
   import { isCacheAvailable } from "~/@/lib/kv-cache";
   console.log("Cache available:", isCacheAvailable());
   ```

2. **Check server logs** for cache operations

3. **Verify cron job** is running (in production)

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

## Documentation

- **TESTING_CACHE_OPTIMIZATION.md** - Detailed testing guide
- **TESTING_GUIDE.md** - Quick reference
- **TESTING_SUMMARY.md** - Test coverage summary
- **scripts/test-cache.sh** - Automated integration test

## Next Steps

1. ✅ Unit tests created
2. ✅ Integration test script created
3. ✅ Documentation written
4. ⏳ Run tests in CI/CD
5. ⏳ Monitor cache hit rates in production
6. ⏳ Benchmark performance improvements

