# Caching Strategy for gRPC/Connect-RPC Server Actions

## Issue: "Failed to generate cache key" Warnings

### The Problem

Previously, we attempted to use Next.js's Data Cache (`fetch` with `next: { revalidate }`) wrapper around gRPC/Connect-RPC calls. This caused "Failed to generate cache key" warnings because:

1. **Next.js Data Cache limitations with gRPC:**
   - All gRPC requests use **POST** to the same base URL
   - Parameters are encoded in the **binary protobuf body**
   - Next.js can't differentiate requests to generate unique cache keys
   - Cache keys are generated from: URL + method + headers + body
   - For gRPC: URL is always the same, method is always POST

2. **Example of the problem:**
   ```typescript
   // Both calls go to the same URL with POST
   getTopShorts({ period: "1M", limit: 10, offset: 0 })
   getTopShorts({ period: "3M", limit: 10, offset: 0 })
   
   // Next.js can't tell them apart → cache key generation fails
   ```

### The Solution

We now use a **two-tier caching strategy**:

#### 1. React `cache()` - Request Deduplication (Same Render)
- Wraps all server action functions
- Deduplicates identical calls during a single request/render cycle
- Perfect for SSR where components might call the same action multiple times
- In-memory cache that lives for the duration of one request

```typescript
export const getTopShortsData = cache(
  async (period: string, limit: number, offset: number) => {
    // If called multiple times with same params during one render,
    // only executes once
    const transport = createConnectTransport({
      baseUrl: SHORTS_API_URL,
    });
    // ...
  }
);
```

#### 2. Page-level ISR - Long-term Caching (Cross-request)
- Use `export const revalidate = 60` at the page level
- Next.js caches the entire page for 60 seconds
- Works well with Vercel's CDN for edge caching
- Simpler and more reliable than per-fetch caching

```typescript
// In page.tsx
export const revalidate = 60; // Cache page for 60 seconds

export default async function Page() {
  // These calls are deduplicated by React cache()
  const data = await getTopShortsData("3m", 10, 0);
  const treeMap = await getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE);
  
  return <YourComponent data={data} treeMap={treeMap} />;
}
```

## Benefits of This Approach

1. **No cache key warnings** - React cache() doesn't need cache keys
2. **Simple and reliable** - Two clear caching layers with different purposes
3. **Better DX** - No complex fetch wrappers to maintain
4. **Edge-friendly** - Page-level ISR works great with CDN
5. **Type-safe** - Works seamlessly with TypeScript and protobuf

## Caching Layers Summary

| Layer | Scope | Duration | Purpose |
|-------|-------|----------|---------|
| React `cache()` | Single request | One render cycle | Deduplicate calls in same render |
| Page ISR `revalidate` | Cross-request | 60 seconds | Cache entire page on CDN |
| Backend cache | Service-level | Varies | Cache at data source |

## Files Updated

- ✅ `web/src/app/actions/getIndustryTreeMap.ts` - Removed `cachedFetch` wrapper
- ✅ `web/src/app/actions/getTopShorts.ts` - Removed `cachedFetch` wrapper
- ✅ `web/src/app/actions/getStockData.ts` - Removed `cachedFetch` wrapper
- ✅ All other server actions already using correct pattern

## Implementation Pattern

```typescript
// ✅ CORRECT: Use React cache() only
import { cache } from "react";

export const myServerAction = cache(async (params) => {
  const transport = createConnectTransport({
    baseUrl: API_URL,
  });
  const client = createPromiseClient(Service, transport);
  return toPlainMessage(await client.method(params));
});
```

```typescript
// ❌ WRONG: Don't wrap fetch with Next.js cache for gRPC
const cachedFetch: typeof fetch = (input, init) => {
  return fetch(input, {
    ...init,
    next: { revalidate: 60 }, // Doesn't work for gRPC POST requests
  });
};
```

## Future Considerations

If we need more granular caching control, we could:
1. Implement a custom in-memory cache with LRU eviction
2. Use Redis for distributed caching
3. Add cache headers to gRPC responses
4. Use Vercel's Data Cache API directly (when available for gRPC)

For now, the two-tier approach (React cache + Page ISR) is optimal.

