# SSR Performance Fix - Removed React cache() from Client Components

## Problem
The home page was experiencing slow performance when loading top shorts and treemap data. Queries were taking much longer than expected.

## Root Cause
The `getTopShortsData` and `getIndustryTreeMap` functions were wrapped with React's `cache()` function, which is designed for **Server Components only**. However, these functions were being called from Client Components (via `useEffect` on the home page).

When `cache()` is used in Client Components:
- It doesn't work as intended (no caching benefit)
- Adds unnecessary overhead
- Can cause performance degradation
- React warns that cache() should only be used in Server Components

## Solution
Removed the `cache()` wrapper from both functions and converted them to regular async functions:

### Before (SLOW - with cache):
```typescript
import { cache } from "react";

export const getTopShortsData = cache(
  async (period: string, limit: number, offset: number) => {
    // ... implementation
  }
);
```

### After (FAST - without cache):
```typescript
export async function getTopShortsData(
  period: string,
  limit: number,
  offset: number,
) {
  // ... implementation
}
```

## Performance Impact
- **Before**: Slow initial load, queries taking longer than expected
- **After**: Fast, direct API calls without unnecessary caching overhead

## When to Use React cache()
✅ **DO use `cache()` when:**
- Calling from Server Components (during SSR)
- You need request-level deduplication
- The component has `"use server"` or no "use client"

❌ **DON'T use `cache()` when:**
- Calling from Client Components (those with "use client")
- Using in `useEffect`, `useState`, or event handlers
- The function is client-side only

## Files Modified
- `web/src/app/actions/getTopShorts.ts` - Removed `cache()` wrapper
- `web/src/app/actions/getIndustryTreeMap.ts` - Removed `cache()` wrapper

## How These Functions Are Used
Both functions are called from Client Components:
1. **Home page** (`web/src/app/page.tsx`):
   - Has `"use client"` directive
   - Calls both functions in a `useEffect` hook
   - Needs fast, direct API calls

2. **Top Shorts page** (`web/src/app/shorts/page.tsx`):
   - Has `"use client"` directive
   - Calls `getTopShortsData` in `useEffect`

3. **TopShorts component** (`web/src/app/topShortsView/topShorts.tsx`):
   - Client component
   - Calls `getTopShortsData` when changing time periods

## Alternative Caching Strategies
If you need client-side caching in the future, consider:
1. **React Query / TanStack Query**: Provides proper client-side caching
2. **SWR**: Another client-side data fetching library with caching
3. **useMemo**: For memoizing computed data
4. **Custom cache implementation**: Using localStorage or IndexedDB

## Testing
After this fix, you should notice:
- Faster initial page load
- Quicker response when changing time periods
- More consistent performance
- No React warnings about cache() usage

