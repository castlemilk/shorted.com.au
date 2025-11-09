# SSR to CSR Migration - Fixing 504 Gateway Timeouts

## Problem
The application was experiencing 504 Gateway Timeout errors when the backend API was slow. This happened because:

1. **Server-Side Rendering (SSR)**: The main page was a Server Component that awaited data from backend APIs before rendering
2. **Server Action Bottleneck**: Even though child components were client-side, they called "server actions" that ran on the Next.js server
3. **Vercel/Platform Timeouts**: Serverless functions typically have 60-second timeouts, causing 504 errors when backend was slow

## Solution
Converted the application to **Client-Side Rendering (CSR)** with direct browser-to-backend API calls:

### Changes Made

#### 1. Main Page (`/web/src/app/page.tsx`)
- **Before**: Server Component with `await getTopShortsData()` and `await getIndustryTreeMap()`
- **After**: Client Component (`"use client"`) that renders immediately
- **Auth**: Changed from `await auth()` to `useSession()` hook
- **Data Loading**: No initial data fetching - components load their own data

#### 2. Created Client-Side API Functions
- **New files**:
  - `/web/src/app/actions/client/getTopShorts.ts`
  - `/web/src/app/actions/client/getIndustryTreeMap.ts`
- **Key difference**: No `cache()` function (server-only) - pure client-side calls
- **Direct calls**: Browser → Backend API (no Next.js server middleman)

#### 3. Updated Components
- **TopShorts** (`/web/src/app/topShortsView/topShorts.tsx`):
  - Made `initialShortsData` optional
  - Fetches data on mount using `getTopShortsDataClient`
  - Shows skeleton loading state while fetching
  
- **IndustryTreeMapView** (`/web/src/app/treemap/treeMap.tsx`):
  - Made `initialTreeMapData` optional
  - Fetches data on mount using `getIndustryTreeMapClient`
  - Shows skeleton loading state while fetching

#### 4. Updated Tests
- Changed mocks from server-side to client-side
- Updated to use `useSession()` instead of `auth()`
- Simplified tests for client component behavior

## How This Fixes 504 Errors

### Before (SSR Flow):
```
User Request → Next.js Server → Backend API (slow) → Timeout (504) → User sees error
```
- Server must wait for backend before responding
- Server timeout limits apply (typically 60s)
- If backend is slow, user sees 504 error

### After (CSR Flow):
```
User Request → Next.js Server → Instant HTML Response → User sees loading UI
                                                          ↓
                                    Browser → Backend API (slow) → Eventually loads
```
- Server responds immediately with HTML
- Browser makes API calls directly
- User sees beautiful loading animations
- No server timeout - browser waits as long as needed
- If backend is slow, user sees loading state (not an error)

## Benefits

1. **No More 504 Errors**: Server doesn't wait for backend, so no server timeouts
2. **Faster Initial Load**: Page renders immediately, showing loading states
3. **Better UX**: Users see progress (loading animations) instead of errors
4. **Independent Loading**: Each component loads independently
5. **More Resilient**: If one API is slow, others still load

## Trade-offs

1. **SEO**: Less server-rendered content (but main content still available via client-side)
2. **Initial Data**: No initial data in HTML (but loads quickly after)
3. **JavaScript Required**: Page requires JS to load data (but this was already the case for interactions)

## Verification

To verify the fix:
1. Start the application
2. Navigate to the home page
3. You should see skeleton loading states immediately
4. Data loads as it becomes available
5. Even if backend is slow (>60s), you'll see loading states, not 504 errors

## Future Considerations

If you want to maintain some SSR benefits while avoiding timeouts:
1. Use **ISR (Incremental Static Regeneration)** with revalidation
2. Implement **Streaming SSR** with React Suspense
3. Add **timeout handling** to server actions (fail fast, fallback to client)
4. Use **CDN caching** for slow endpoints

