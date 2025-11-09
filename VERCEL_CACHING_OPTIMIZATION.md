# Vercel Caching Optimization

## Problem Statement

The homepage was experiencing 504 timeout errors during SSR (Server-Side Rendering) when the backend service was slow. Every page request triggered fresh backend API calls, with no global caching in place.

## Solution Implemented

Implemented a comprehensive caching strategy using Next.js's built-in caching mechanisms to enable Vercel's global CDN cache with stale-while-revalidate patterns.

## Changes Made

### 1. Homepage Configuration (`web/src/app/page.tsx`)

#### Added ISR Configuration

```typescript
export const revalidate = 60; // Revalidate every 60 seconds
export const maxDuration = 30; // 30-second execution timeout
```

**What this does:**

- **ISR (Incremental Static Regeneration)**: Vercel generates the page statically at build time and serves it from the global CDN
- After 60 seconds, the first request triggers a background revalidation
- Subsequent requests continue to receive the cached version while revalidation happens
- **Stale-while-revalidate**: Users always get fast responses, even during revalidation

#### Error Handling & Resilience

- Added `Promise.all` for parallel data fetching
- Implemented `.catch()` handlers with fallback data
- Added top-level try-catch to prevent complete page failures
- Pages render with empty data if backend fails, rather than showing errors

### 2. Server Actions Caching

Updated three server actions to use Next.js's fetch cache:

- `web/src/app/actions/getTopShorts.ts`
- `web/src/app/actions/getIndustryTreeMap.ts`
- `web/src/app/actions/getStockData.ts`

#### Custom Cached Fetch Function

```typescript
const cachedFetch: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  return fetch(input, {
    ...init,
    signal: controller.signal,
    next: {
      revalidate: 60, // Cache for 60 seconds
      tags: ["top-shorts"], // Tag for manual revalidation
    },
  }).finally(() => clearTimeout(timeoutId));
};
```

**What this does:**

- **Next.js Data Cache**: Caches fetch responses at the data layer
- **15-second timeout**: Prevents hanging requests to slow backends
- **Cache tags**: Allows manual cache invalidation when needed
- **Stale-while-revalidate**: Serves cached data while fetching fresh data in background

## How It Works

### Before (SSR without caching):

```
User Request → Vercel Server → Backend API (slow) → Wait... → 504 Timeout
```

### After (ISR with caching):

```
First Request:
User Request → Vercel Server → Backend API → Cache → Response (slow first time)

Subsequent Requests (within 60s):
User Request → Vercel CDN Cache → Instant Response ⚡

After 60s (stale-while-revalidate):
User Request → Vercel CDN Cache → Instant Response (stale) ⚡
             ↳ Background: Fetch fresh data → Update cache
```

## Benefits

1. **Global CDN Caching**: Vercel serves the homepage from edge locations worldwide
2. **Stale-while-revalidate**: Users always get instant responses, never wait for backend
3. **Resilient to Backend Slowness**: If backend is slow, users still get cached data
4. **Timeout Protection**: 15-second fetch timeout + 30-second max execution time
5. **Error Recovery**: Graceful fallbacks if data fetching fails
6. **Reduced Backend Load**: Backend is hit once per minute max, not on every request

## Cache Invalidation

If you need to manually invalidate the cache:

```typescript
import { revalidateTag } from "next/cache";

// Invalidate specific cache entries
revalidateTag("top-shorts");
revalidateTag("industry-treemap");
revalidateTag("stock-data");

// Or revalidate the entire page
import { revalidatePath } from "next/cache";
revalidatePath("/");
```

## Vercel Deployment Settings

Ensure your `vercel.json` or project settings have:

```json
{
  "builds": [
    {
      "src": "package.json",
      "use": "@vercel/next"
    }
  ]
}
```

No additional configuration needed - Next.js ISR works out of the box on Vercel!

## Monitoring

Monitor cache effectiveness:

- Check Vercel Analytics for response times
- Look for reduced backend API calls in your backend logs
- Cache hit ratios should be high after initial warming

## Cache Behavior by Vercel Plan

- **Hobby**: Cache purged after 24 hours of inactivity
- **Pro**: Extended cache retention
- **Enterprise**: Full control over cache behavior

## Next Steps (Optional Improvements)

1. **Longer cache times for stable data**: If short positions don't change frequently, increase `revalidate` to 300 (5 minutes) or more
2. **Static Generation**: Consider fully static generation with `generateStaticParams()` for common routes
3. **Cache warming**: Implement a cron job to keep cache warm by hitting the page every minute
4. **Redis cache layer**: Add Redis between Next.js and backend for additional caching
5. **Service Worker**: Implement service worker for client-side caching

## Testing

Test the caching behavior:

1. **First Load**: Should take full time to load from backend
2. **Second Load (within 60s)**: Should be near-instant from cache
3. **After 60s**: Should still be instant (stale), then update in background
4. **Backend Down**: Page should still load with last cached data

## Related Documentation

- [Next.js Data Caching](https://nextjs.org/docs/app/building-your-application/caching#data-cache)
- [Next.js ISR](https://nextjs.org/docs/app/building-your-application/data-fetching/fetching-caching-and-revalidating#revalidating-data)
- [Vercel Edge Network](https://vercel.com/docs/edge-network/overview)
